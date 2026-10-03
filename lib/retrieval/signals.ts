/**
 * Lexical signals pulled from a diff for retrieval and classification (R6.5, R6.7): identifiers the change introduces
 * or references, new string constants and config keys, path-like literals, and dependency edits in manifests.
 * Everything here is pure and deterministic.
 */
import path from "node:path/posix";
import { detectFileType } from "@/lib/indexer/filetypes";
import type { FileDiff } from "@/lib/review/diff";

const KEYWORDS = new Set(
  `abstract any as async await boolean break case catch class const constructor continue debugger declare default
  delete do else enum export extends false finally for from function get if implements import in instanceof interface
  keyof let module namespace never new null number object of package private protected public readonly require return
  set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with
  yield def elif except lambda nonlocal pass raise self None True False print func go chan defer fallthrough map range
  struct select impl trait pub mut fn crate use where loop match ref move dyn unsafe extern final override virtual using
  internal sealed partial var val println console log length push value values keys items error result data`
    .split(/\s+/)
    .filter(Boolean),
);

export function addedLines(d: FileDiff): string[] {
  return d.lines.filter((l) => l.kind === "add").map((l) => l.text);
}

export function removedLines(d: FileDiff): string[] {
  return d.lines.filter((l) => l.kind === "del").map((l) => l.text);
}

/** Strips comments-only lines so identifiers in prose do not drive retrieval. */
function codeOnly(lines: string[]): string[] {
  return lines.filter((l) => !/^\s*(\/\/|#|\*|\/\*|--)/.test(l));
}

/**
 * Identifiers in added lines that look like program names (camelCase, PascalCase, snake_case, or UPPER_SNAKE), in
 * first-seen order. Plain lowercase words are skipped: they are mostly keywords and locals.
 */
export function referencedIdentifiers(diffs: FileDiff[], limit = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    for (const line of codeOnly(addedLines(d))) {
      const stripped = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ");
      for (const m of stripped.matchAll(/[A-Za-z_$][\w$]{3,}/g)) {
        const id = m[0];
        if (seen.has(id) || KEYWORDS.has(id.toLowerCase())) continue;
        if (!/[A-Z_]/.test(id.slice(1)) && !/^[A-Z]/.test(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const PATH_LIKE = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.[\]-]+)+\/?$|^[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|rb|json|ya?ml|toml|sql|md|env|sh)$/;

/** String literals in added lines, split into path-like literals and other constants (messages, keys, flags). */
export function stringLiterals(diffs: FileDiff[], limit = 20): { paths: string[]; constants: string[] } {
  const paths: string[] = [];
  const constants: string[] = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    for (const line of codeOnly(addedLines(d))) {
      for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).){4,80})\1/g)) {
        const value = m[2]!.trim();
        if (seen.has(value) || !/[A-Za-z]/.test(value) || /\$\{/.test(value)) continue;
        seen.add(value);
        if (PATH_LIKE.test(value) && !/^https?:/.test(value)) {
          if (paths.length < limit) paths.push(value.replace(/^\.\//, ""));
        } else if (/^[\w.:-]+$/.test(value) || /^[\w .,:'!?-]{6,}$/.test(value)) {
          if (constants.length < limit) constants.push(value);
        }
      }
    }
  }
  return { paths, constants };
}

/** UPPER_SNAKE identifiers and dotted config keys introduced by the diff (e.g. `MAX_RETRIES`, `billing.region`). */
export function configKeys(diffs: FileDiff[], limit = 15): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    for (const line of codeOnly(addedLines(d))) {
      for (const m of line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
        if (!seen.has(m[0]) && out.length < limit) {
          seen.add(m[0]);
          out.push(m[0]);
        }
      }
    }
  }
  return out;
}

export interface DependencyChange {
  manifest: string;
  name: string;
  change: "added" | "removed" | "changed";
  from: string | null;
  to: string | null;
}

/** `"name": "^1.2.3"`, `name==1.2`, `name = "1.2"`, `name v1.2.3` (go.mod), `<artifactId>`-less simple forms. */
const DEP_LINE = [
  /^\s*"(@?[\w./-]+)"\s*:\s*"([^"]*\d[^"]*|\*|latest|workspace:[^"]*)"\s*,?\s*$/,
  /^\s*([A-Za-z0-9][\w.-]*)(?:\[[\w,.-]+\])?\s*(==|>=|~=|<=|!=|>|<)\s*([\w.*-]+)/,
  /^\s*([A-Za-z0-9][\w-]*)\s*=\s*"([^"]*\d[^"]*)"\s*$/,
  /^\s*([\w.-]+\/[\w./-]+)\s+(v\d[\w.+-]*)/,
];

function parseDepLine(line: string): { name: string; version: string } | null {
  for (const re of DEP_LINE) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const version = (m.length > 3 ? `${m[2]}${m[3]}` : m[2]!).trim();
    if (["version", "name", "main", "type", "license", "description", "go", "edition"].includes(name)) return null;
    return { name, version };
  }
  return null;
}

/** Dependencies added, removed, or re-versioned by manifest edits in the diff. */
export function dependencyChanges(diffs: FileDiff[]): DependencyChange[] {
  const out: DependencyChange[] = [];
  for (const d of diffs) {
    if (!detectFileType(d.path)?.manifest) continue;
    const added = new Map<string, string>();
    const removed = new Map<string, string>();
    for (const l of d.lines) {
      if (l.kind === "ctx") continue;
      const dep = parseDepLine(l.text);
      if (!dep) continue;
      (l.kind === "add" ? added : removed).set(dep.name, dep.version);
    }
    for (const [name, to] of added) {
      const from = removed.get(name) ?? null;
      if (from === to) continue;
      out.push({ manifest: d.path, name, change: from === null ? "added" : "changed", from, to });
    }
    for (const [name, from] of removed) if (!added.has(name)) out.push({ manifest: d.path, name, change: "removed", from, to: null });
  }
  return out.sort((a, b) => a.manifest.localeCompare(b.manifest) || a.name.localeCompare(b.name));
}

/** The component a path belongs to: its first two directory levels (e.g. `services/billing`). */
export function componentOf(p: string): string {
  const dirs = p.split("/").slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join("/") : "(root)";
}

/** Directories from `p`'s own directory up to the repository root (`""`). */
export function ancestorDirs(p: string): string[] {
  const out: string[] = [];
  let dir = path.dirname(p);
  for (;;) {
    out.push(dir === "." ? "" : dir);
    if (dir === "." || dir === "/" || dir === "") return out;
    dir = path.dirname(dir);
  }
}

/** Words of a free-text question worth searching for (identifiers, quoted terms, paths). */
export function questionTerms(question: string): { identifiers: string[]; paths: string[]; words: string[] } {
  const identifiers = new Set<string>();
  for (const m of question.matchAll(/`([^`]+)`/g)) {
    const inner = m[1]!.replace(/\(\)$/, "");
    if (/^[A-Za-z_$][\w$.]*$/.test(inner)) identifiers.add(inner.split(".").pop()!);
  }
  for (const m of question.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const id = m[0];
    if (id.length > 3 && !KEYWORDS.has(id.toLowerCase()) && (/[A-Z_]/.test(id.slice(1)) || /\(\)/.test(question.slice(m.index! + id.length, m.index! + id.length + 2)))) {
      identifiers.add(id);
    }
  }
  const paths = [...question.matchAll(/[\w@.-]+(?:\/[\w@.-]+)+|[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|rb|json|ya?ml|toml|sql|md)\b/g)].map((m) => m[0]);
  const words = [...new Set((question.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []).filter((w) => !KEYWORDS.has(w)))].slice(0, 12);
  return { identifiers: [...identifiers].slice(0, 20), paths: [...new Set(paths)].slice(0, 10), words };
}
