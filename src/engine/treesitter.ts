import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import type Parser from "web-tree-sitter";

// Lazily loaded tree-sitter grammars (web-tree-sitter 0.22 + tree-sitter-wasms). Only the
// languages present in a batch are loaded; any failure leaves the regex fallback in place so
// indexing never breaks. TS/JS keep the TypeScript compiler path in indexer.ts.
export const grammarByExtension: Record<string, string> = {
  py: "python", pyi: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin", rs: "rust", rb: "ruby",
  cs: "c_sharp", php: "php", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", swift: "swift",
  ex: "elixir", exs: "elixir",
};
export const grammarFor = (file: string) => grammarByExtension[file.split(".").pop()?.toLowerCase() ?? ""];

type Runtime = { Parser: typeof Parser; grammars: string };
let runtime: Promise<Runtime | null> | undefined;
const parsers = new Map<string, Parser>();
const failed = new Map<string, string>();

function load(): Promise<Runtime | null> {
  runtime ??= (async () => {
    try {
      // Node 24's optimizing WASM tier crashes (Zone OOM) when it tiers up these large grammar
      // modules, either eagerly or via dynamic tiering of hot parse functions; the baseline
      // compiler parses fine. Applies only to WebAssembly compilation.
      setFlagsFromString("--no-wasm-tier-up");
      setFlagsFromString("--no-wasm-dynamic-tiering");
      // Literal dynamic imports let the Convex bundler mark both packages as deployed externals.
      const TreeSitter = (await import("web-tree-sitter")).default as typeof Parser;
      await import("tree-sitter-wasms/package.json", { with: { type: "json" } });
      const packageDir = (name: string) => path.dirname(fileURLToPath(import.meta.resolve(name + "/package.json")));
      // Self-hosted and offline installs can point at a bundled directory (scripts/bundle-grammars.ts)
      // instead of the installed packages; files are checked against its SHA-256 manifest.
      const bundled = process.env.OPENREVIEW_GRAMMARS_DIR;
      const grammars = bundled ? path.resolve(bundled) : path.join(packageDir("tree-sitter-wasms"), "out");
      const core = bundled ? path.join(grammars, "tree-sitter.wasm") : path.join(packageDir("web-tree-sitter"), "tree-sitter.wasm");
      if (bundled) await verifiedGrammarFile(grammars, "tree-sitter.wasm");
      await TreeSitter.init({ locateFile: () => core });
      return { Parser: TreeSitter, grammars };
    } catch (error) {
      failed.set("runtime", error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  return runtime;
}

// A bundled grammar file, accepted only when its SHA-256 matches the bundle's manifest.json.
export async function verifiedGrammarFile(dir: string, file: string) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { files?: Record<string, string> };
  const expected = manifest.files?.[file];
  if (!expected) throw new Error(`${file} is not in the grammar bundle manifest`);
  const bytes = await readFile(path.join(dir, file));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`${file} does not match the grammar bundle manifest`);
  return bytes;
}
export const supportedGrammars = () => [...new Set(Object.values(grammarByExtension))].sort();

export async function loadGrammars(files: Iterable<string>): Promise<void> {
  const wanted = new Set<string>();
  for (const file of files) { const g = grammarFor(file); if (g && !parsers.has(g) && !failed.has(g)) wanted.add(g); }
  if (!wanted.size) return;
  const rt = await load();
  if (!rt) return;
  for (const grammar of wanted) {
    try {
      const bytes = process.env.OPENREVIEW_GRAMMARS_DIR ? await verifiedGrammarFile(rt.grammars, `tree-sitter-${grammar}.wasm`) : await readFile(path.join(rt.grammars, `tree-sitter-${grammar}.wasm`));
      const language = await rt.Parser.Language.load(new Uint8Array(bytes));
      const parser = new rt.Parser();
      parser.setLanguage(language);
      parser.setTimeoutMicros(3_000_000);
      parsers.set(grammar, parser);
    } catch (error) {
      failed.set(grammar, error instanceof Error ? error.message : String(error));
    }
  }
}
export const parserFor = (file: string) => { const g = grammarFor(file); return g ? parsers.get(g) : undefined; };
export const grammarStatus = () => ({ loaded: [...parsers.keys()].sort(), failed: Object.fromEntries(failed) });
