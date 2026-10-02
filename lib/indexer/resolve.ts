import path from "node:path/posix";
import type { LanguageId } from "./languages";

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function firstExisting(candidates: string[], files: Set<string>): string[] {
  for (const c of candidates) if (files.has(c)) return [c];
  return [];
}

function jsCandidates(base: string): string[] {
  const stripped = base.replace(/\.(m|c)?js$/, "");
  return [
    base,
    ...JS_EXTS.map((e) => stripped + e),
    ...JS_EXTS.map((e) => `${stripped}/index${e}`),
  ];
}

function pythonCandidates(mod: string): string[] {
  const p = mod.replace(/\./g, "/");
  return [`${p}.py`, `${p}/__init__.py`];
}

/**
 * Resolves an import string to repo-relative file paths (R1.3). Best effort per
 * language: unresolvable (third-party) imports return [] and stay as named edges.
 */
export function resolveImport(language: LanguageId, fromPath: string, target: string, files: Set<string>): string[] {
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
      const out: string[] = [];
      for (const f of files) {
        if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
        const d = path.dirname(f);
        if (d !== "." && (target === d || target.endsWith(`/${d}`))) out.push(f);
      }
      return out.sort();
    }
    case "java": {
      const suffix = `${target.replace(/\./g, "/")}.java`;
      return [...files].filter((f) => f === suffix || f.endsWith(`/${suffix}`)).slice(0, 1);
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
        const d = segs.slice(segs.length - n).join("/");
        const hits = [...files].filter((f) => f.endsWith(".cs") && (path.dirname(f) === d || path.dirname(f).endsWith(`/${d}`)));
        if (hits.length) return hits.sort();
      }
      return [];
    }
  }
}
