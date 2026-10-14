import { z } from "zod";
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

export type LoadedRepoConfig = { settings: z.infer<typeof repoSettingsSchema>; rules: Rule[]; files: string[]; warnings: string[]; directories: { directory: string; instructions?: string }[] };
type Source = { tree(repository: string, sha: string): Promise<{ path: string; sha: string; size?: number }[]>; blob(repository: string, path: string, sha: string): Promise<{ content: string; size?: number }> };
const parseJson = (text: string, file: string, warnings: string[]): RepoConfig | undefined => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { warnings.push(`${file} is not valid JSON; it was ignored.`); return undefined; }
  const parsed = repoConfigSchema.safeParse(raw);
  if (!parsed.success) { warnings.push(`${file} is invalid (${parsed.error.issues.slice(0, 3).map((i) => (i.path.join(".") || "root") + ": " + i.message).join("; ")}); it was ignored.`); return undefined; }
  return parsed.data;
};
const scopeGlob = (directory: string, glob: string) => (glob.startsWith("/") ? glob.slice(1) : `${directory}/${glob}`);

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
  for (const entry of tree.filter((e) => e.path.endsWith("/.openreview.json") && !e.path.startsWith(".openreview/")).slice(0, 50)) {
    const directory = entry.path.slice(0, -"/.openreview.json".length);
    const text = await read(entry.path);
    const config = text === undefined ? undefined : parseJson(text, entry.path, warnings);
    if (!config) continue;
    if (config.settings && Object.keys(config.settings).some((k) => k !== "instructions")) warnings.push(`${entry.path}: nested files only add rules and instructions; other settings were ignored.`);
    rules.push(...(config.rules ?? []).map((r) => ({ ...r, id: `${directory}:${r.id}`, globs: r.globs.length ? r.globs.map((g) => scopeGlob(directory, g)) : [`${directory}/**`] })));
    if (config.settings?.instructions) directories.push({ directory, instructions: config.settings.instructions.slice(0, 4000) });
  }
  const seen = new Set<string>();
  return { settings, rules: rules.filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, 100), files, warnings, directories };
}

// Applies the repository file on top of dashboard settings, skipping admin-locked keys.
export function applyRepoConfig<T extends Record<string, unknown>>(dashboard: T & { lockedKeys?: string[] }, loaded: Pick<LoadedRepoConfig, "settings" | "directories">) {
  const locked = new Set(dashboard.lockedKeys ?? []), applied: RepoConfigurableKey[] = [], blocked: RepoConfigurableKey[] = [];
  const result: Record<string, unknown> = { ...dashboard };
  for (const key of repoConfigurableKeys) {
    if (loaded.settings[key] === undefined) continue;
    if (locked.has(key)) { blocked.push(key); continue; }
    result[key] = loaded.settings[key];
    applied.push(key);
  }
  const scoped = loaded.directories.filter((d) => d.instructions).map((d) => `For files under ${d.directory}/: ${d.instructions}`);
  if (scoped.length && !locked.has("instructions")) result.instructions = [result.instructions, ...scoped].filter(Boolean).join("\n\n").slice(0, 20000);
  return { settings: result as T, applied, blocked };
}
