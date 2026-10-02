/**
 * Package manifests → module + dependencies (R6.3). Each manifest becomes one `module` symbol with `depends_on`
 * edges to its dependencies (external packages, or sibling modules in a monorepo), and one `repo_dependencies` row
 * per declared dependency.
 */
import path from "node:path/posix";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { ManifestType } from "./filetypes";

export type Ecosystem = "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget" | "rubygems";
export type DependencyKind = "prod" | "dev" | "peer" | "build" | "optional";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  versionSpec: string | null;
  kind: DependencyKind;
}

export interface ManifestModule {
  /** Package / module name (falls back to the manifest's directory or the repository name). */
  name: string;
  ecosystem: Ecosystem;
  dependencies: Dependency[];
  /** Sibling modules referenced by path rather than by package name (Gradle `project(":x")`, `ProjectReference`). */
  localModules: string[];
  /** Workspace member globs (npm/yarn/pnpm workspaces, Cargo workspace members, Maven modules). */
  workspaces: string[];
}

const MAX_DEPENDENCIES = 1000;

function fallbackName(manifestPath: string, repoName: string): string {
  const dir = path.dirname(manifestPath);
  return dir === "." ? repoName : dir;
}

function dedupe(deps: Dependency[]): Dependency[] {
  const seen = new Set<string>();
  const out: Dependency[] = [];
  for (const d of deps) {
    const key = `${d.ecosystem}:${d.name}:${d.kind}`;
    if (!d.name || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= MAX_DEPENDENCIES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// npm

const stringRecord = z.record(z.string(), z.unknown()).catch({});
const packageJson = z.object({
  name: z.string().optional().catch(undefined),
  dependencies: stringRecord.optional(),
  devDependencies: stringRecord.optional(),
  peerDependencies: stringRecord.optional(),
  optionalDependencies: stringRecord.optional(),
  workspaces: z
    .union([z.array(z.string()), z.object({ packages: z.array(z.string()).optional() })])
    .optional()
    .catch(undefined),
});

function parsePackageJson(text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const pkg = packageJson.parse(JSON.parse(text));
  const deps: Dependency[] = [];
  const add = (record: Record<string, unknown> | undefined, kind: DependencyKind) => {
    for (const [name, spec] of Object.entries(record ?? {})) {
      deps.push({ ecosystem: "npm", name, versionSpec: typeof spec === "string" ? spec : null, kind });
    }
  };
  add(pkg.dependencies, "prod");
  add(pkg.devDependencies, "dev");
  add(pkg.peerDependencies, "peer");
  add(pkg.optionalDependencies, "optional");
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  return { name: pkg.name, ecosystem: "npm", dependencies: deps, localModules: [], workspaces };
}

// ---------------------------------------------------------------------------------------------------------------
// Python

/** One PEP 508 requirement (`name[extra]>=1.0; marker`) → name + version spec. */
export function parsePep508(req: string): { name: string; versionSpec: string | null } | null {
  const egg = /#egg=([A-Za-z0-9._-]+)/.exec(req);
  if (egg) return { name: egg[1]!.toLowerCase(), versionSpec: null };
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:@\s*(\S+)|\(?\s*([^;#)]*?)\s*\)?)?\s*(?:;.*)?$/.exec(req);
  if (!m) return null;
  const spec = (m[2] ?? m[3] ?? "").trim();
  return { name: m[1]!.toLowerCase().replace(/_/g, "-"), versionSpec: spec || null };
}

function parseRequirements(manifestPath: string, text: string): Omit<ManifestModule, "name"> {
  const dev = /(?:^|[-_.])(?:dev|test|tests|lint|docs|ci)(?:[-_.]|$)/i.test(path.basename(manifestPath).replace(/\.txt$/i, ""));
  const deps: Dependency[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-r") || line.startsWith("-c") || (line.startsWith("-") && !line.startsWith("-e"))) continue;
    const req = parsePep508(line.replace(/^-e\s+/, ""));
    if (req) deps.push({ ecosystem: "pypi", ...req, kind: dev ? "dev" : "prod" });
  }
  return { ecosystem: "pypi", dependencies: deps, localModules: [], workspaces: [] };
}

type TomlTable = Record<string, unknown>;
const isTable = (v: unknown): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);
const tableAt = (t: unknown, ...keys: string[]): TomlTable | undefined => {
  let cur: unknown = t;
  for (const k of keys) cur = isTable(cur) ? cur[k] : undefined;
  return isTable(cur) ? cur : undefined;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function tomlVersion(spec: unknown): string | null {
  if (typeof spec === "string") return spec;
  if (isTable(spec)) {
    if (typeof spec.version === "string") return spec.version;
    if (typeof spec.path === "string") return `path:${spec.path}`;
    if (typeof spec.git === "string") return `git:${spec.git}`;
    if (spec.workspace === true) return "workspace";
  }
  return null;
}

const DEV_GROUPS = /^(?:dev|test|tests|lint|docs|typing|ci)$/i;

function parsePyproject(text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const doc = parseToml(text) as TomlTable;
  const deps: Dependency[] = [];
  const pep = (reqs: unknown, kind: DependencyKind) => {
    for (const r of strings(reqs)) {
      const parsed = parsePep508(r);
      if (parsed) deps.push({ ecosystem: "pypi", ...parsed, kind });
    }
  };
  const project = tableAt(doc, "project");
  pep(project?.dependencies, "prod");
  for (const [group, reqs] of Object.entries(tableAt(project, "optional-dependencies") ?? {})) pep(reqs, DEV_GROUPS.test(group) ? "dev" : "optional");
  for (const [, reqs] of Object.entries(tableAt(doc, "dependency-groups") ?? {})) pep(reqs, "dev");
  pep(tableAt(doc, "build-system")?.requires, "build");

  const poetry = tableAt(doc, "tool", "poetry");
  const poetryDeps = (t: TomlTable | undefined, kind: DependencyKind) => {
    for (const [name, spec] of Object.entries(t ?? {})) {
      if (name.toLowerCase() === "python") continue;
      const optional = isTable(spec) && spec.optional === true;
      deps.push({ ecosystem: "pypi", name: name.toLowerCase(), versionSpec: tomlVersion(spec), kind: optional ? "optional" : kind });
    }
  };
  poetryDeps(tableAt(poetry, "dependencies"), "prod");
  poetryDeps(tableAt(poetry, "dev-dependencies"), "dev");
  for (const [group, t] of Object.entries(tableAt(poetry, "group") ?? {})) {
    poetryDeps(tableAt(t, "dependencies"), DEV_GROUPS.test(group) ? "dev" : "optional");
  }
  const name = typeof project?.name === "string" ? project.name : typeof poetry?.name === "string" ? poetry.name : undefined;
  return { name, ecosystem: "pypi", dependencies: deps, localModules: [], workspaces: [] };
}

function parsePipfile(text: string): Omit<ManifestModule, "name"> {
  const doc = parseToml(text) as TomlTable;
  const deps: Dependency[] = [];
  for (const [section, kind] of [["packages", "prod"], ["dev-packages", "dev"]] as const) {
    for (const [name, spec] of Object.entries(tableAt(doc, section) ?? {})) {
      deps.push({ ecosystem: "pypi", name: name.toLowerCase(), versionSpec: tomlVersion(spec), kind });
    }
  }
  return { ecosystem: "pypi", dependencies: deps, localModules: [], workspaces: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Go

function parseGoMod(text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const deps: Dependency[] = [];
  let name: string | undefined;
  let inRequire = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const indirect = /\/\/\s*indirect/.test(raw);
    if (!line) continue;
    const mod = /^module\s+(\S+)/.exec(line);
    if (mod) name = mod[1]!.replace(/^"|"$/g, "");
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const req = inRequire ? /^(\S+)\s+(\S+)/.exec(line) : /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (req) deps.push({ ecosystem: "go", name: req[1]!, versionSpec: req[2]!, kind: indirect ? "optional" : "prod" });
  }
  return { name, ecosystem: "go", dependencies: deps, localModules: [], workspaces: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Rust

function parseCargo(text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const doc = parseToml(text) as TomlTable;
  const deps: Dependency[] = [];
  const add = (t: TomlTable | undefined, kind: DependencyKind) => {
    for (const [key, spec] of Object.entries(t ?? {})) {
      const name = isTable(spec) && typeof spec.package === "string" ? spec.package : key;
      const optional = isTable(spec) && spec.optional === true;
      deps.push({ ecosystem: "cargo", name, versionSpec: tomlVersion(spec), kind: optional ? "optional" : kind });
    }
  };
  const sections = (t: TomlTable | undefined) => {
    add(tableAt(t, "dependencies"), "prod");
    add(tableAt(t, "dev-dependencies"), "dev");
    add(tableAt(t, "build-dependencies"), "build");
  };
  sections(doc);
  for (const target of Object.values(tableAt(doc, "target") ?? {})) sections(isTable(target) ? target : undefined);
  add(tableAt(doc, "workspace", "dependencies"), "prod");
  const pkg = tableAt(doc, "package");
  return {
    name: typeof pkg?.name === "string" ? pkg.name : undefined,
    ecosystem: "cargo",
    dependencies: deps,
    localModules: [],
    workspaces: strings(tableAt(doc, "workspace")?.members),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JVM / .NET (XML and Gradle DSL, parsed with tolerant regexes)

function xmlText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return m?.[1] || undefined;
}

function stripXmlBlocks(xml: string, tags: string[]): string {
  let out = xml.replace(/<!--[\s\S]*?-->/g, "");
  for (const t of tags) out = out.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, "g"), "");
  return out;
}

function parsePom(text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const top = stripXmlBlocks(xml, ["parent", "dependencies", "dependencyManagement", "build", "profiles", "modules", "plugins", "reporting"]);
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(xml)?.[1] ?? "";
  const groupId = xmlText(top, "groupId") ?? xmlText(parent, "groupId");
  const artifactId = xmlText(top, "artifactId");
  const deps: Dependency[] = [];
  const managed = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
  for (const m of xml.replace(managed, "").matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = m[1]!;
    const g = xmlText(block, "groupId");
    const a = xmlText(block, "artifactId");
    if (!a) continue;
    const scope = xmlText(block, "scope");
    const optional = xmlText(block, "optional") === "true";
    const kind: DependencyKind = optional ? "optional" : scope === "test" ? "dev" : scope === "provided" ? "peer" : "prod";
    deps.push({ ecosystem: "maven", name: g ? `${g}:${a}` : a, versionSpec: xmlText(block, "version") ?? null, kind });
  }
  for (const m of xml.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g)) {
    const a = xmlText(m[1]!, "artifactId");
    const g = xmlText(m[1]!, "groupId") ?? "org.apache.maven.plugins";
    if (a) deps.push({ ecosystem: "maven", name: `${g}:${a}`, versionSpec: xmlText(m[1]!, "version") ?? null, kind: "build" });
  }
  const workspaces = [...(/<modules>([\s\S]*?)<\/modules>/.exec(xml)?.[1] ?? "").matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]!);
  return { name: artifactId ? (groupId ? `${groupId}:${artifactId}` : artifactId) : undefined, ecosystem: "maven", dependencies: deps, localModules: [], workspaces };
}

const GRADLE_CONFIGS: Record<string, DependencyKind> = {
  implementation: "prod",
  api: "prod",
  compile: "prod",
  runtimeOnly: "prod",
  runtime: "prod",
  compileOnly: "peer",
  compileOnlyApi: "peer",
  testImplementation: "dev",
  testCompile: "dev",
  testRuntimeOnly: "dev",
  testCompileOnly: "dev",
  androidTestImplementation: "dev",
  debugImplementation: "dev",
  annotationProcessor: "build",
  kapt: "build",
  ksp: "build",
  classpath: "build",
};

/** Gradle project path for a build file's directory (`core/build.gradle` → `:core`). */
export function gradleProjectName(manifestPath: string): string {
  const dir = path.dirname(manifestPath);
  return dir === "." ? ":" : `:${dir.split("/").join(":")}`;
}

function parseGradle(manifestPath: string, text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const deps: Dependency[] = [];
  const local: string[] = [];
  const configs = Object.keys(GRADLE_CONFIGS).join("|");
  const coord = new RegExp(`\\b(${configs})\\s*\\(?\\s*(?:platform\\()?["']([^"':\\s]+):([^"':\\s]+)(?::([^"'\\s]+))?["']`, "g");
  for (const m of text.matchAll(coord)) {
    deps.push({ ecosystem: "maven", name: `${m[2]}:${m[3]}`, versionSpec: m[4] ?? null, kind: GRADLE_CONFIGS[m[1]!]! });
  }
  const named = new RegExp(`\\b(${configs})\\s*\\(?\\s*group\\s*[:=]\\s*["']([^"']+)["']\\s*,\\s*name\\s*[:=]\\s*["']([^"']+)["'](?:\\s*,\\s*version\\s*[:=]\\s*["']([^"']+)["'])?`, "g");
  for (const m of text.matchAll(named)) {
    deps.push({ ecosystem: "maven", name: `${m[2]}:${m[3]}`, versionSpec: m[4] ?? null, kind: GRADLE_CONFIGS[m[1]!]! });
  }
  for (const m of text.matchAll(/\bproject\s*\(\s*(?:path\s*[:=]\s*)?["'](:[^"']*)["']\s*\)/g)) local.push(m[1]!);
  return { name: gradleProjectName(manifestPath), ecosystem: "maven", dependencies: deps, localModules: local, workspaces: [] };
}

function xmlAttr(tag: string, attr: string): string | undefined {
  return new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];
}

function parseCsproj(manifestPath: string, text: string): Omit<ManifestModule, "name"> & { name?: string } {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const deps: Dependency[] = [];
  for (const m of xml.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/g)) {
    const attrs = m[1]!;
    const name = xmlAttr(attrs, "Include") ?? xmlAttr(attrs, "Update");
    if (!name) continue;
    const version = xmlAttr(attrs, "Version") ?? (m[2] ? xmlText(m[2], "Version") : undefined) ?? null;
    const privateAssets = xmlAttr(attrs, "PrivateAssets") ?? (m[2] ? xmlText(m[2], "PrivateAssets") : undefined);
    deps.push({ ecosystem: "nuget", name, versionSpec: version, kind: privateAssets?.toLowerCase() === "all" ? "dev" : "prod" });
  }
  const local = [...xml.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/g)].map((m) => {
    const file = m[1]!.replace(/\\/g, "/");
    return path.basename(file).replace(/\.[a-z]+proj$/i, "");
  });
  const name = xmlText(xml, "AssemblyName") ?? path.basename(manifestPath).replace(/\.csproj$/i, "");
  return { name, ecosystem: "nuget", dependencies: deps, localModules: local, workspaces: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Ruby

function parseGemfile(text: string): Omit<ManifestModule, "name"> {
  const deps: Dependency[] = [];
  const groupStack: boolean[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const group = /^group\s+(.+?)\s+do\b/.exec(line);
    if (group) {
      groupStack.push(/:(?:development|test)\b|["'](?:development|test)["']/.test(group[1]!));
      continue;
    }
    if (/^(?:end)\b/.test(line)) {
      groupStack.pop();
      continue;
    }
    if (/\bdo\b\s*(\|.*\|)?\s*$/.test(line)) groupStack.push(groupStack[groupStack.length - 1] ?? false);
    const gem = /^gem\s+["']([^"']+)["']\s*(.*)$/.exec(line);
    if (!gem) continue;
    const versions = [...gem[2]!.matchAll(/(?:^|,)\s*["']([~<>=!]*\s*[\d][^"']*)["']/g)].map((m) => m[1]!.trim());
    const inlineGroup = /\bgroups?:\s*(?:\[[^\]]*\]|:\w+)/.exec(gem[2]!)?.[0] ?? "";
    const dev = groupStack[groupStack.length - 1] === true || /development|test/.test(inlineGroup);
    deps.push({ ecosystem: "rubygems", name: gem[1]!, versionSpec: versions.length ? versions.join(", ") : null, kind: dev ? "dev" : "prod" });
  }
  return { ecosystem: "rubygems", dependencies: deps, localModules: [], workspaces: [] };
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Parses a manifest. Returns null when the file cannot be parsed (invalid JSON/TOML), so a broken manifest never
 * fails an index run.
 */
export function parseManifest(type: ManifestType, manifestPath: string, text: string, repoName: string): ManifestModule | null {
  let parsed: Omit<ManifestModule, "name"> & { name?: string };
  try {
    switch (type) {
      case "package.json":
        parsed = parsePackageJson(text);
        break;
      case "requirements.txt":
        parsed = parseRequirements(manifestPath, text);
        break;
      case "pyproject.toml":
        parsed = parsePyproject(text);
        break;
      case "Pipfile":
        parsed = parsePipfile(text);
        break;
      case "go.mod":
        parsed = parseGoMod(text);
        break;
      case "Cargo.toml":
        parsed = parseCargo(text);
        break;
      case "pom.xml":
        parsed = parsePom(text);
        break;
      case "build.gradle":
        parsed = parseGradle(manifestPath, text);
        break;
      case "csproj":
        parsed = parseCsproj(manifestPath, text);
        break;
      case "Gemfile":
        parsed = parseGemfile(text);
        break;
    }
  } catch {
    return null;
  }
  return {
    ...parsed,
    name: parsed.name || fallbackName(manifestPath, repoName),
    dependencies: dedupe(parsed.dependencies),
  };
}
