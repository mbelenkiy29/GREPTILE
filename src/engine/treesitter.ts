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
      const core = path.join(packageDir("web-tree-sitter"), "tree-sitter.wasm");
      await TreeSitter.init({ locateFile: () => core });
      return { Parser: TreeSitter, grammars: path.join(packageDir("tree-sitter-wasms"), "out") };
    } catch (error) {
      failed.set("runtime", error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  return runtime;
}

export async function loadGrammars(files: Iterable<string>): Promise<void> {
  const wanted = new Set<string>();
  for (const file of files) { const g = grammarFor(file); if (g && !parsers.has(g) && !failed.has(g)) wanted.add(g); }
  if (!wanted.size) return;
  const rt = await load();
  if (!rt) return;
  for (const grammar of wanted) {
    try {
      const wasm = path.join(rt.grammars, `tree-sitter-${grammar}.wasm`);
      const language = await rt.Parser.Language.load(new Uint8Array(await readFile(wasm)));
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
