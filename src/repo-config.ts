import { z } from "zod";
import picomatch from "picomatch";
import { categories, severities, type Rule } from "./engine/types";
import { summarySections } from "./review-settings";

// Repository configuration as code, shared by the CLI and server reviews. Server reviews read it
// from the pull request's BASE revision, so a change can never disable or weaken its own review.
// Precedence: workspace → team → repository dashboard → repository file, except admin-locked keys.
export const repoConfigFiles = [".openreview.json", ".openreview/config.json", ".openreview/rules.md"] as const;
export const repoConfigurableKeys = ["mode", "minimumConfidence", "severityThreshold", "maxComments", "categories", "ignoredPaths", "instructions", "commentStyle", "summarySections", "strictness", "reviewEngine"] as const;
export type RepoConfigurableKey = (typeof repoConfigurableKeys)[number];

const ruleSchema = z.object({
  id: z.string().min(1).max(100),
  instructions: z.string().min(1).max(4000),
  severity: z.enum(severities),
  category: z.string().min(1).max(50),
  globs: z.array(z.string().max(300)).max(50),
  enabled: z.boolean(),
}).strict();
export const repoSettingsSchema = z.object({
  mode: z.enum(["fast", "standard", "deep"]),
  minimumConfidence: z.number().min(0.5).max(1),
  severityThreshold: z.enum(severities),
  maxComments: z.number().int().min(0).max(30),
  categories: z.array(z.enum(categories)).max(categories.length),
  ignoredPaths: z.array(z.string().max(300)).max(200),
  instructions: z.string().max(20000),
  commentStyle: z.enum(["concise", "detailed"]),
  summarySections: z.array(z.enum(summarySections)).max(summarySections.length),
  strictness: z.number().int().min(0).max(3),
  reviewEngine: z.enum(["pipeline", "agentic", "hypotheses"]),
}).partial().strict();
export const repoConfigSchema = z.object({
  $schema: z.string().optional(),
  settings: repoSettingsSchema.optional(),
  rules: z.array(ruleSchema).max(100).optional(),
}).strict();
export type RepoConfig = z.infer<typeof repoConfigSchema>;

// rules.md: "## Title" sections; optional leading "severity:", "category:" and "globs:" lines.
export function parseRulesMarkdown(text: string, idPrefix = "repo"): Rule[] {
  const rules: Rule[] = [];
  for (const section of text.replace(/\r\n/g, "\n").split(/^## +/m).slice(1)) {
    const [heading, ...body] = section.split("\n");
    const meta: Record<string, string> = {};
    let i = 0;
    for (; i < body.length; i++) {
      const m = /^(severity|category|globs):\s*(.+)$/i.exec(body[i].trim());
      if (!m) { if (body[i].trim()) break; continue; }
      meta[m[1].toLowerCase()] = m[2].trim();
    }
    const instructions = body.slice(i).join("\n").trim();
    if (!heading.trim() || !instructions) continue;
    const severity = (severities as readonly string[]).includes(meta.severity ?? "") ? (meta.severity as Rule["severity"]) : "medium";
    rules.push({ id: `${idPrefix}:${heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}`, instructions: `${heading.trim()}: ${instructions}`.slice(0, 4000), severity, category: meta.category?.slice(0, 50) || "rules", globs: meta.globs ? meta.globs.split(",").map((g) => g.trim()).filter(Boolean).slice(0, 50) : [], enabled: true });
  }
  return rules.slice(0, 100);
}

// files.json: ignore and include globs relative to the folder's parent directory.
export const filesConfigSchema = z.object({ ignore: z.array(z.string().min(1).max(300)).max(200).optional(), include: z.array(z.string().min(1).max(300)).max(200).optional() }).strict();
// One level of the cascade: the root ("") or a directory holding an .openreview/ folder.
export type ConfigLevel = { directory: string; settings: z.infer<typeof repoSettingsSchema>; files?: z.infer<typeof filesConfigSchema>; sources: string[] };
export type LoadedRepoConfig = { settings: z.infer<typeof repoSettingsSchema>; rules: Rule[]; files: string[]; warnings: string[]; directories: { directory: string; instructions?: string }[]; guides?: { path: string; content: string }[]; levels?: ConfigLevel[] };
type Source = { tree(repository: string, sha: string): Promise<{ path: string; sha: string; size?: number }[]>; blob(repository: string, path: string, sha: string): Promise<{ content: string; size?: number }> };
const parseJson = (text: string, file: string, warnings: string[]): RepoConfig | undefined => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { warnings.push(`${file} is not valid JSON; it was ignored.`); return undefined; }
  const parsed = repoConfigSchema.safeParse(raw);
  if (!parsed.success) { warnings.push(`${file} is invalid (${parsed.error.issues.slice(0, 3).map((i) => (i.path.join(".") || "root") + ": " + i.message).join("; ")}); it was ignored.`); return undefined; }
  return parsed.data;
};
const scopeGlob = (directory: string, glob: string) => (glob.startsWith("/") ? glob.slice(1) : directory ? `${directory}/${glob}` : glob);
const parseFiles = (text: string, file: string, warnings: string[]) => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { warnings.push(`${file} is not valid JSON; it was ignored.`); return undefined; }
  const parsed = filesConfigSchema.safeParse(raw);
  if (!parsed.success) { warnings.push(`${file} is invalid (${parsed.error.issues.slice(0, 3).map((i) => (i.path.join(".") || "root") + ": " + i.message).join("; ")}); it was ignored.`); return undefined; }
  return parsed.data;
};

// Loads configuration from a revision tree. Nested "<dir>/.openreview.json" files add rules and
// instructions scoped to that directory (their globs are prefixed); they cannot change settings.
export async function loadRepoConfig(source: Source, repository: string, sha: string): Promise<LoadedRepoConfig> {
  const tree = await source.tree(repository, sha);
  const warnings: string[] = [], files: string[] = [], rules: Rule[] = [], directories: LoadedRepoConfig["directories"] = [];
  let settings: z.infer<typeof repoSettingsSchema> = {};
  const read = async (path: string) => {
    const entry = tree.find((e) => e.path === path);
    if (!entry) return undefined;
    if ((entry.size ?? 0) > 64_000) { warnings.push(`${path} exceeds 64 KB; it was ignored.`); return undefined; }
    const blob = await source.blob(repository, path, entry.sha);
    files.push(path);
    return blob.content;
  };
  for (const path of [".openreview.json", ".openreview/config.json"]) {
    const text = await read(path);
    const config = text === undefined ? undefined : parseJson(text, path, warnings);
    if (config) { settings = { ...settings, ...config.settings }; rules.push(...(config.rules ?? [])); }
  }
  const markdown = await read(".openreview/rules.md");
  if (markdown !== undefined) rules.push(...parseRulesMarkdown(markdown));
  // K1: .openreview/ folders at any depth cascade by directory (deeper overrides shallower per field).
  const levels: ConfigLevel[] = [];
  const level = (directory: string) => { let l = levels.find((x) => x.directory === directory); if (!l) { l = { directory, settings: {}, sources: [] }; levels.push(l); } return l; };
  const rootFiles = await read(".openreview/files.json");
  if (rootFiles !== undefined) { const parsed = parseFiles(rootFiles, ".openreview/files.json", warnings); if (parsed) { const l = level(""); l.files = parsed; l.sources.push(".openreview/files.json"); } }
  const nested = [...new Set(tree.map((e) => /^(.+)\/\.openreview\/(?:config\.json|rules\.md|files\.json)$/.exec(e.path)?.[1]).filter((d): d is string => !!d && !d.split("/").includes(".openreview")))].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (nested.length > 50) warnings.push(`${nested.length - 50} nested .openreview folders beyond the first 50 were ignored.`);
  for (const directory of nested.slice(0, 50)) {
    const l = level(directory);
    const configText = await read(`${directory}/.openreview/config.json`);
    const config = configText === undefined ? undefined : parseJson(configText, `${directory}/.openreview/config.json`, warnings);
    if (config) {
      const { instructions, ...rest } = config.settings ?? {};
      l.settings = rest; l.sources.push(`${directory}/.openreview/config.json`);
      if (instructions) directories.push({ directory, instructions: instructions.slice(0, 4000) });
      rules.push(...(config.rules ?? []).map((r) => ({ ...r, id: `${directory}:${r.id}`, globs: r.globs.length ? r.globs.map((g) => scopeGlob(directory, g)) : [`${directory}/**`] })));
    }
    const md = await read(`${directory}/.openreview/rules.md`);
    if (md !== undefined) { l.sources.push(`${directory}/.openreview/rules.md`); rules.push(...parseRulesMarkdown(md, directory).map((r) => ({ ...r, globs: r.globs.length ? r.globs.map((g) => scopeGlob(directory, g)) : [`${directory}/**`] }))); }
    const filesText = await read(`${directory}/.openreview/files.json`);
    const files = filesText === undefined ? undefined : parseFiles(filesText, `${directory}/.openreview/files.json`, warnings);
    if (files) { l.files = files; l.sources.push(`${directory}/.openreview/files.json`); }
  }
  for (const entry of tree.filter((e) => e.path.endsWith("/.openreview.json") && !e.path.startsWith(".openreview/")).slice(0, 50)) {
    const directory = entry.path.slice(0, -"/.openreview.json".length);
    const text = await read(entry.path);
    const config = text === undefined ? undefined : parseJson(text, entry.path, warnings);
    if (!config) continue;
    if (config.settings && Object.keys(config.settings).some((k) => k !== "instructions")) warnings.push(`${entry.path}: nested files only add rules and instructions; other settings were ignored.`);
    rules.push(...(config.rules ?? []).map((r) => ({ ...r, id: `${directory}:${r.id}`, globs: r.globs.length ? r.globs.map((g) => scopeGlob(directory, g)) : [`${directory}/**`] })));
    if (config.settings?.instructions) directories.push({ directory, instructions: config.settings.instructions.slice(0, 4000) });
  }
  // API guidance packs (J7): at most 10 Markdown files under .openreview/guides/.
  const guides: { path: string; content: string }[] = [];
  for (const entry of tree.filter((e) => /^\.openreview\/guides\/[^/]+\.md$/.test(e.path)).slice(0, 10)) {
    if ((entry.size ?? 0) > 16_000) { warnings.push(`${entry.path} exceeds 16 KB; it was ignored.`); continue; }
    const text = await read(entry.path);
    if (text !== undefined) guides.push({ path: entry.path, content: text });
  }
  const seen = new Set<string>();
  return { settings, rules: rules.filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, 100), files, warnings, directories, guides, levels: levels.filter((l) => l.sources.length) };
}

// Applies the repository file on top of dashboard settings, skipping admin-locked keys.
export function applyRepoConfig<T extends Record<string, unknown>>(dashboard: T & { lockedKeys?: string[] }, loaded: Pick<LoadedRepoConfig, "settings" | "directories" | "levels">, touched: string[] = []) {
  const locked = new Set(dashboard.lockedKeys ?? []), applied: RepoConfigurableKey[] = [], blocked: RepoConfigurableKey[] = [];
  const result: Record<string, unknown> = { ...dashboard };
  for (const key of repoConfigurableKeys) {
    if (loaded.settings[key] === undefined) continue;
    if (locked.has(key)) { blocked.push(key); continue; }
    result[key] = loaded.settings[key];
    applied.push(key);
  }
  // Touched directories can raise the PR-wide tier and comment limit above the root value, never lower them.
  const pr = pullRequestSettings(loaded.levels ?? [], touched, [...locked]);
  if (pr.settings.mode && tiers.indexOf(pr.settings.mode) > tiers.indexOf((result.mode as (typeof tiers)[number]) ?? "fast")) { result.mode = pr.settings.mode; if (!applied.includes("mode")) applied.push("mode"); }
  if (pr.settings.maxComments !== undefined && pr.settings.maxComments > Number(result.maxComments ?? 0)) { result.maxComments = pr.settings.maxComments; if (!applied.includes("maxComments")) applied.push("maxComments"); }
  const scoped = loaded.directories.filter((d) => d.instructions).map((d) => `For files under ${d.directory}/: ${d.instructions}`);
  if (scoped.length && !locked.has("instructions")) result.instructions = [result.instructions, ...scoped].filter(Boolean).join("\n\n").slice(0, 20000);
  return { settings: result as T, applied, blocked };
}

// Per-file values: deeper folders override shallower ones field by field; admin-locked keys never
// change. Ignore/include globs apply root first, so a deeper include can re-admit a file.
export const perFileKeys = ["categories", "strictness", "severityThreshold", "minimumConfidence"] as const;
export type PerFileKey = (typeof perFileKeys)[number];
const under = (path: string, directory: string) => !directory || path.startsWith(directory + "/");
const depthOrder = (levels: ConfigLevel[]) => [...levels].sort((a, b) => (a.directory ? a.directory.split("/").length : 0) - (b.directory ? b.directory.split("/").length : 0));
export function fileSettings(levels: ConfigLevel[], path: string, locked: readonly string[] = []) {
  const settings: Partial<Pick<z.infer<typeof repoSettingsSchema>, PerFileKey>> = {}, sources: Partial<Record<PerFileKey, string>> = {};
  let ignored = false, ignoredBy: string | undefined;
  for (const l of depthOrder(levels).filter((l) => under(path, l.directory))) {
    for (const key of perFileKeys) if (l.settings[key] !== undefined && !locked.includes(key)) { (settings as Record<string, unknown>)[key] = l.settings[key]; sources[key] = l.directory || "(root)"; }
    if (l.files?.ignore?.length && !locked.includes("ignoredPaths") && picomatch(l.files.ignore.map((g) => scopeGlob(l.directory, g)), { dot: true })(path)) { ignored = true; ignoredBy = (l.directory ? l.directory + "/" : "") + ".openreview/files.json"; }
    if (l.files?.include?.length && picomatch(l.files.include.map((g) => scopeGlob(l.directory, g)), { dot: true })(path)) { ignored = false; ignoredBy = undefined; }
  }
  return { settings, sources, ignored, ignoredBy };
}
// Pull-request-wide values from the directories a change touches: the highest review tier and the
// largest comment limit win (a deeper or sibling folder can raise them, never lower the root's).
const tiers = ["fast", "standard", "deep"] as const;
export function pullRequestSettings(levels: ConfigLevel[], touched: string[], locked: readonly string[] = []) {
  const applicable = levels.filter((l) => l.directory && touched.some((p) => under(p, l.directory)));
  const result: { mode?: (typeof tiers)[number]; maxComments?: number } = {}, sources: Record<string, string> = {};
  for (const l of applicable) {
    if (l.settings.mode && !locked.includes("mode") && (!result.mode || tiers.indexOf(l.settings.mode) > tiers.indexOf(result.mode))) { result.mode = l.settings.mode; sources.mode = l.directory; }
    if (l.settings.maxComments !== undefined && !locked.includes("maxComments") && l.settings.maxComments > (result.maxComments ?? -1)) { result.maxComments = l.settings.maxComments; sources.maxComments = l.directory; }
  }
  return { settings: result, sources };
}
// The cascade as recorded for the dashboard's effective-configuration view.
export const cascadeSummary = (levels: ConfigLevel[] = []) => depthOrder(levels).map((l) => ({ directory: l.directory || "(root)", sources: l.sources, keys: Object.keys(l.settings), ignore: l.files?.ignore?.length ?? 0, include: l.files?.include?.length ?? 0 }));
