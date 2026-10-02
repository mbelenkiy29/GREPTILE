import path from "node:path/posix";
import type { LanguageId } from "./languages";

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * Repository paths with lookup indexes, so resolving an import costs O(path segments) instead of a scan of every
 * file (which made whole-repo resolution quadratic).
 */
export class PathIndex {
  readonly files: Set<string>;
  private byDir?: Map<string, string[]>;
  private byBase?: Map<string, string[]>;
  /** Directory suffix (`a/b`, `b`) → directories ending with it. */
  private dirsBySuffix?: Map<string, string[]>;

  constructor(paths: Iterable<string>) {
    this.files = paths instanceof Set ? (paths as Set<string>) : new Set(paths);
  }

  has(p: string) {
    return this.files.has(p);
  }

  filesInDir(dir: string): string[] {
    if (!this.byDir) {
      this.byDir = new Map();
      for (const f of this.files) {
        const d = path.dirname(f);
        const list = this.byDir.get(d);
        if (list) list.push(f);
        else this.byDir.set(d, [f]);
      }
    }
    return this.byDir.get(dir) ?? [];
  }

  filesNamed(base: string): string[] {
    if (!this.byBase) {
      this.byBase = new Map();
      for (const f of this.files) {
        const b = path.basename(f);
        const list = this.byBase.get(b);
        if (list) list.push(f);
        else this.byBase.set(b, [f]);
      }
    }
    return this.byBase.get(base) ?? [];
  }

  /** Directories equal to `suffix` or ending with `/suffix`. */
  dirsEndingWith(suffix: string): string[] {
    if (!this.dirsBySuffix) {
      this.dirsBySuffix = new Map();
      const dirs = new Set([...this.files].map((f) => path.dirname(f)));
      for (const d of dirs) {
        if (d === ".") continue;
        const segs = d.split("/");
        for (let i = 0; i < segs.length; i++) {
          const key = segs.slice(i).join("/");
          const list = this.dirsBySuffix.get(key);
          if (list) list.push(d);
          else this.dirsBySuffix.set(key, [d]);
        }
      }
    }
    return this.dirsBySuffix.get(suffix) ?? [];
  }
}

function firstExisting(candidates: string[], files: PathIndex): string[] {
  for (const c of candidates) if (files.has(c)) return [c];
  return [];
}

function jsCandidates(base: string): string[] {
  const stripped = base.replace(/\.(m|c)?js$/, "");
  return [base, ...JS_EXTS.map((e) => stripped + e), ...JS_EXTS.map((e) => `${stripped}/index${e}`)];
}

function pythonCandidates(mod: string): string[] {
  const p = mod.replace(/\./g, "/");
  return [`${p}.py`, `${p}/__init__.py`];
}

/**
 * Resolves an import string to repo-relative file paths (R1.3). Best effort per language: unresolvable (third-party)
 * imports return [] and stay as named edges.
 */
export function resolveImport(language: LanguageId, fromPath: string, target: string, paths: Set<string> | PathIndex): string[] {
  const files = paths instanceof PathIndex ? paths : new PathIndex(paths);
  const dir = path.dirname(fromPath);
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript": {
      if (target.startsWith(".")) return firstExisting(jsCandidates(path.normalize(path.join(dir, target))), files);
      if (target.startsWith("@/") || target.startsWith("~/")) {
        const rest = target.slice(2);
        return firstExisting([...jsCandidates(rest), ...jsCandidates(`src/${rest}`)], files);
      }
      return [];
    }
    case "python": {
      const dots = target.match(/^\.+/)?.[0].length ?? 0;
      if (dots > 0) {
        let base = dir;
        for (let i = 1; i < dots; i++) base = path.dirname(base);
        const rest = target.slice(dots);
        if (!rest) return firstExisting([path.join(base, "__init__.py")], files);
        return firstExisting(pythonCandidates(rest).map((c) => path.normalize(path.join(base, c))), files);
      }
      return firstExisting([...pythonCandidates(target), ...pythonCandidates(target).map((c) => `src/${c}`)], files);
    }
    case "go": {
      // A Go import path names a package directory; match the longest directory suffix of the import path.
      const segs = target.split("/");
      const out = new Set<string>();
      for (let i = 0; i < segs.length; i++) {
        for (const d of files.dirsEndingWith(segs.slice(i).join("/"))) {
          if (target === d || target.endsWith(`/${d}`)) {
            for (const f of files.filesInDir(d)) if (f.endsWith(".go") && !f.endsWith("_test.go")) out.add(f);
          }
        }
      }
      return [...out].sort();
    }
    case "java": {
      const suffix = `${target.replace(/\./g, "/")}.java`;
      return files
        .filesNamed(path.basename(suffix))
        .filter((f) => f === suffix || f.endsWith(`/${suffix}`))
        .sort()
        .slice(0, 1);
    }
    case "rust": {
      if (!target.includes("::")) {
        return firstExisting([path.join(dir, `${target}.rs`), path.join(dir, target, "mod.rs")], files);
      }
      const segs = target.split("::");
      let base = dir;
      if (segs[0] === "crate") {
        const src = fromPath.indexOf("src/");
        base = src >= 0 ? fromPath.slice(0, src + 3) : ".";
        segs.shift();
      } else if (segs[0] === "self") {
        segs.shift();
      } else if (segs[0] === "super") {
        base = path.dirname(dir);
        segs.shift();
      } else {
        return [];
      }
      for (let n = segs.length; n > 0; n--) {
        const p = path.normalize(path.join(base, ...segs.slice(0, n)));
        const hit = firstExisting([`${p}.rs`, `${p}/mod.rs`], files);
        if (hit.length) return hit;
      }
      return [];
    }
    case "csharp": {
      const segs = target.split(".");
      for (let n = segs.length; n > 0; n--) {
        const suffix = segs.slice(segs.length - n).join("/");
        const hits = files.dirsEndingWith(suffix).flatMap((d) => files.filesInDir(d).filter((f) => f.endsWith(".cs")));
        if (hits.length) return [...new Set(hits)].sort();
      }
      return [];
    }
  }
}
