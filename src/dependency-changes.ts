import { parsePatch } from "./diff-view";
import type { ChangedFile } from "./engine/types";

// Added or changed dependency versions read from manifest and lockfile diffs. Each change keeps the
// exact added line (head line number and text) so an advisory finding can anchor on it.
export const ecosystems = ["npm", "PyPI", "Go", "crates.io", "Maven"] as const;
export type Ecosystem = (typeof ecosystems)[number];
export type DependencyChange = { ecosystem: Ecosystem; name: string; version: string; path: string; line: number; quote: string };
// Lockfiles of ecosystems the advisory check does not cover yet; reported, never silently ignored.
const unsupported = /(^|\/)(Gemfile\.lock|composer\.lock|mix\.lock|pubspec\.lock|Package\.resolved|packages\.lock\.json|gradle\.lockfile|Podfile\.lock)$/;
const semver = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.+-]+)?$/;
const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
type Line = { kind: "add" | "del" | "ctx"; new?: number; text: string };
type Parser = (lines: Line[], emit: (name: string, version: string, line: Line) => void) => void;

const exact = (spec: string) => { const v = spec.trim().replace(/^[\^~=v]+/, ""); return semver.test(v) ? v : undefined; };
const parsers: [RegExp, Ecosystem, Parser][] = [
  [/(^|\/)package\.json$/, "npm", (lines, emit) => {
    const skip = new Set(["version", "node", "npm", "pnpm", "yarn", "packageManager"]);
    for (const l of lines) {
      const m = /^\s*"(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)"\s*:\s*"([^"]+)"/i.exec(l.text);
      const version = m && !skip.has(m[1]) ? exact(m[2]) : undefined;
      if (l.kind === "add" && m && version) emit(m[1], version, l);
    }
  }],
  [/(^|\/)(package-lock|npm-shrinkwrap)\.json$/, "npm", (lines, emit) => {
    let name: string | undefined;
    for (const l of lines) {
      const key = /^\s*"(?:[^"]*node_modules\/)?(@?[^"/]+(?:\/[^"/]+)?)"\s*:\s*\{\s*$/.exec(l.text);
      if (key && !/^(dependencies|packages|requires|devDependencies|optionalDependencies|peerDependencies|engines|funding|bin)$/.test(key[1])) name = key[1];
      const version = /^\s*"version"\s*:\s*"([^"]+)"/.exec(l.text);
      if (l.kind === "add" && version && name && semver.test(version[1])) emit(name, version[1], l);
    }
  }],
  [/(^|\/)pnpm-lock\.yaml$/, "npm", (lines, emit) => {
    for (const l of lines) {
      // v6+: "  /name@1.2.3:" or "  'name@1.2.3(peer@1)':"; v5: "  /name/1.2.3:".
      const m = /^ {2}'?\/?((?:@[^@/\s']+\/)?[^@/\s']+)[@/](\d[^\s:'()_]*)(?:\([^)]*\))*(?:_[^\s:']*)?'?:\s*$/.exec(l.text);
      if (l.kind === "add" && m && semver.test(m[2])) emit(m[1], m[2], l);
    }
  }],
  [/(^|\/)yarn\.lock$/, "npm", (lines, emit) => {
    let name: string | undefined;
    for (const l of lines) {
      const header = /^"?((?:@[^@\s"/]+\/)?[^@\s",]+)@/.exec(l.text);
      if (header && !/^\s/.test(l.text)) name = header[1];
      const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(l.text);
      if (l.kind === "add" && version && name && semver.test(version[1])) emit(name, version[1], l);
    }
  }],
  [/(^|\/)requirements[^/]*\.txt$/, "PyPI", (lines, emit) => {
    for (const l of lines) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)\s*(?:[;#].*)?$/.exec(l.text);
      if (l.kind === "add" && m) emit(pep503(m[1]), m[2], l);
    }
  }],
  [/(^|\/)poetry\.lock$/, "PyPI", (lines, emit) => {
    let name: string | undefined;
    for (const l of lines) {
      if (/^\[\[package\]\]/.test(l.text)) name = undefined;
      const n = /^name\s*=\s*"([^"]+)"/.exec(l.text); if (n) name = pep503(n[1]);
      const v = /^version\s*=\s*"([^"]+)"/.exec(l.text);
      if (l.kind === "add" && v && name) emit(name, v[1], l);
    }
  }],
  [/(^|\/)Pipfile\.lock$/, "PyPI", (lines, emit) => {
    let name: string | undefined;
    for (const l of lines) {
      const key = /^\s*"([A-Za-z0-9][A-Za-z0-9._-]*)"\s*:\s*\{\s*$/.exec(l.text); if (key && !/^(_meta|default|develop|hash|requires|sources)$/.test(key[1])) name = pep503(key[1]);
      const v = /^\s*"version"\s*:\s*"==([^"]+)"/.exec(l.text);
      if (l.kind === "add" && v && name) emit(name, v[1], l);
    }
  }],
  [/(^|\/)go\.(mod|sum)$/, "Go", (lines, emit) => {
    for (const l of lines) {
      const m = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]+)?)\s+v(\d[^\s/]*?)(?:\+incompatible)?(?:\/go\.mod)?(?:\s+h1:\S+)?\s*(?:\/\/.*)?$/i.exec(l.text);
      // OSV Go ranges are semver without the "v" prefix.
      if (l.kind === "add" && m && !/^\s*module\s/.test(l.text)) emit(m[1], m[2], l);
    }
  }],
  [/(^|\/)Cargo\.lock$/, "crates.io", (lines, emit) => {
    let name: string | undefined;
    for (const l of lines) {
      if (/^\[\[package\]\]/.test(l.text)) name = undefined;
      const n = /^name\s*=\s*"([^"]+)"/.exec(l.text); if (n) name = n[1];
      const v = /^version\s*=\s*"([^"]+)"/.exec(l.text);
      if (l.kind === "add" && v && name && semver.test(v[1])) emit(name, v[1], l);
    }
  }],
  [/(^|\/)Cargo\.toml$/, "crates.io", (lines, emit) => {
    for (const l of lines) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:\{[^}]*version\s*=\s*)?"=?(\d+\.\d+\.\d+[^"]*)"/.exec(l.text);
      if (l.kind === "add" && m && m[1] !== "version" && m[1] !== "rust-version") emit(m[1], m[2], l);
    }
  }],
  [/(^|\/)pom\.xml$/, "Maven", (lines, emit) => {
    let group: string | undefined, artifact: string | undefined, inside = false;
    for (const l of lines) {
      if (/<dependency>/.test(l.text)) { inside = true; group = artifact = undefined; }
      if (/<\/dependency>/.test(l.text)) inside = false;
      const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(l.text); if (g) group = g[1];
      const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(l.text); if (a) artifact = a[1];
      const v = /<version>\s*([^<\s$]+)\s*<\/version>/.exec(l.text);
      if (l.kind === "add" && inside && v && group && artifact) emit(`${group}:${artifact}`, v[1], l);
    }
  }],
];
export function dependencyChanges(diff: ChangedFile[]): { changes: DependencyChange[]; unsupported: string[] } {
  const changes: DependencyChange[] = [], skipped: string[] = [];
  for (const file of diff) {
    if (file.status === "removed") continue;
    if (unsupported.test(file.path)) { if (/^\+/m.test(file.patch)) skipped.push(file.path); continue; }
    const parser = parsers.find(([pattern]) => pattern.test(file.path));
    if (!parser) continue;
    const lines = parsePatch(file.patch).flatMap((h) => h.lines);
    parser[2](lines, (name, version, line) => {
      if (line.new === undefined || name.length > 300 || version.length > 100) return;
      if (!changes.some((c) => c.ecosystem === parser[1] && c.name === name && c.version === version)) changes.push({ ecosystem: parser[1], name, version, path: file.path, line: line.new, quote: line.text });
    });
  }
  return { changes, unsupported: skipped };
}
