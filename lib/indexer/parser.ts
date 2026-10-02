import { createRequire } from "node:module";
import path from "node:path";
import { LANGUAGES, languageForPath, type LanguageId, type LanguageSpec } from "./languages";

// The runtime and grammars ship together in @vscode/tree-sitter-wasm, so ABI versions always match.
const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any -- the wasm module ships loose typings */
type TS = any;

export interface ParsedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ParsedFile {
  language: LanguageId;
  symbols: ParsedSymbol[];
  /** Call sites; `from` indexes the innermost enclosing symbol (or null at module level). */
  calls: { name: string; line: number; from: number | null }[];
  imports: { target: string; line: number }[];
}

const MAX_SYMBOL_CHARS = 4000;

interface Loaded {
  language: any;
  definitions: any;
  calls: any;
  imports: any;
}

let runtime: Promise<TS> | undefined;
const loaded = new Map<LanguageId, Promise<Loaded>>();

function wasmDir() {
  return path.dirname(require.resolve("@vscode/tree-sitter-wasm"));
}

function ts(): Promise<TS> {
  runtime ??= (async () => {
    const mod = require("@vscode/tree-sitter-wasm");
    await mod.Parser.init({ locateFile: (file: string) => path.join(wasmDir(), file) });
    return mod;
  })();
  return runtime;
}

function load(spec: LanguageSpec): Promise<Loaded> {
  let entry = loaded.get(spec.id);
  if (!entry) {
    entry = (async () => {
      const mod = await ts();
      const language = await mod.Language.load(path.join(wasmDir(), spec.wasm));
      return {
        language,
        definitions: new mod.Query(language, spec.definitions),
        calls: new mod.Query(language, spec.calls),
        imports: new mod.Query(language, spec.imports),
      };
    })();
    loaded.set(spec.id, entry);
  }
  return entry;
}

/** Loads every grammar and compiles every query; throws if any query is invalid. */
export async function warmUpParsers() {
  await Promise.all(LANGUAGES.map(load));
}

function cleanImport(lang: LanguageId, text: string): string {
  const t = text.trim();
  if (lang === "go") return t.replace(/^["`]|["`]$/g, "");
  if (lang === "rust") return t.replace(/\s+/g, "").replace(/::\{.*$/, "").replace(/::\*$/, "");
  return t;
}

export async function parseSource(filePath: string, source: string): Promise<ParsedFile | null> {
  const spec = languageForPath(filePath);
  if (!spec) return null;
  const mod = await ts();
  const q = await load(spec);
  const parser = new mod.Parser();
  parser.setLanguage(q.language);
  const tree = parser.parse(source);
  if (!tree) return null;
  try {
    const lines = source.split("\n");
    const symbols: ParsedSymbol[] = [];
    const spans: { start: number; end: number }[] = [];
    const seen = new Set<string>();
    for (const match of q.definitions.matches(tree.rootNode)) {
      const def = match.captures.find((c: any) => c.name.startsWith("def."));
      const name = match.captures.find((c: any) => c.name === "name");
      if (!def || !name) continue;
      const startLine = def.node.startPosition.row + 1;
      const endLine = def.node.endPosition.row + 1;
      const key = `${name.node.text}:${def.node.startIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push({ start: def.node.startIndex, end: def.node.endIndex });
      symbols.push({
        name: name.node.text,
        kind: def.name.slice("def.".length),
        startLine,
        endLine,
        content: lines.slice(startLine - 1, endLine).join("\n").slice(0, MAX_SYMBOL_CHARS),
      });
    }

    /** Innermost definition whose byte span contains `offset`. */
    const enclosing = (offset: number): number | null => {
      let best: number | null = null;
      spans.forEach((s, i) => {
        if (s.start <= offset && offset < s.end) {
          const b = best === null ? undefined : spans[best];
          if (!b || s.end - s.start < b.end - b.start) best = i;
        }
      });
      return best;
    };

    const calls = q.calls
      .captures(tree.rootNode)
      .filter((c: any) => c.name === "call")
      .map((c: any) => {
        return { name: c.node.text as string, line: c.node.startPosition.row + 1, from: enclosing(c.node.startIndex) };
      });

    const imports = q.imports
      .captures(tree.rootNode)
      .filter((c: any) => c.name === "import")
      .map((c: any) => ({ target: cleanImport(spec.id, c.node.text), line: c.node.startPosition.row + 1 }))
      .filter((i: { target: string }) => i.target.length > 0);

    return { language: spec.id, symbols, calls, imports };
  } finally {
    tree.delete();
    parser.delete();
  }
}
