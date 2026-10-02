/**
 * Per-file analysis (R6.3 / R6.4): classification tags, symbols, graph edges, retrieval chunks, and declared
 * dependencies for one file. Pure apart from loading tree-sitter grammars; the caller redacts secrets first.
 */
import type { EdgeKind } from "@/lib/db/schema";
import { chunkCode, chunkConfig, chunkDoc, splitLines, type Chunk } from "./chunks";
import { extractCiJobs, extractPrisma, extractSqlTables } from "./extract";
import { classifyPath, hasGeneratedHeader, type FileTag, type FileType } from "./filetypes";
import { parseManifest, type Dependency } from "./manifests";
import { parseSource, type ParsedSymbol } from "./parser";

export interface AnalyzedEdge {
  kind: EdgeKind;
  /** Index into `symbols` of the source symbol, or null for file-level edges. */
  from: number | null;
  /** Symbol name, module specifier, or package name the edge points at (resolved later). */
  target: string;
  line: number;
}

export interface FileAnalysis {
  language: string;
  tags: FileTag[];
  lineCount: number;
  symbols: ParsedSymbol[];
  edges: AnalyzedEdge[];
  chunks: Chunk[];
  dependencies: Dependency[];
}

/** Upper bound on stored edges per kind per file, so one generated-looking file cannot flood the graph. */
const MAX_EDGES_PER_KIND = 2000;

function capEdges(edges: AnalyzedEdge[]): AnalyzedEdge[] {
  const counts = new Map<EdgeKind, number>();
  return edges.filter((e) => {
    const n = counts.get(e.kind) ?? 0;
    counts.set(e.kind, n + 1);
    return n < MAX_EDGES_PER_KIND && e.target.length > 0 && e.target.length <= 500;
  });
}

export async function analyzeFile(filePath: string, text: string, type: FileType, ctx: { repoName: string }): Promise<FileAnalysis> {
  const lines = splitLines(text);
  const lineCount = text.length === 0 ? 0 : lines.length;
  const tags = new Set<FileTag>(classifyPath(filePath, type));
  if (hasGeneratedHeader(text)) {
    tags.add("generated");
    tags.delete("source");
  }

  let symbols: ParsedSymbol[] = [];
  const edges: AnalyzedEdge[] = [];
  let dependencies: Dependency[] = [];

  if (type.treeSitter) {
    const parsed = await parseSource(filePath, text, { isTest: tags.has("test") });
    if (parsed) {
      symbols = parsed.symbols;
      for (const c of parsed.calls) edges.push({ kind: "call", from: c.from, target: c.name, line: c.line });
      for (const i of parsed.imports) edges.push({ kind: "import", from: null, target: i.target, line: i.line });
      for (const e of parsed.exports) edges.push({ kind: "export", from: null, target: e.target, line: e.line });
      for (const r of parsed.references) edges.push({ kind: "reference", from: r.from, target: r.name, line: r.line });
      for (const h of parsed.heritage) edges.push({ kind: h.kind, from: h.from, target: h.name, line: h.line });
      for (const r of parsed.routeHandlers) edges.push({ kind: "route_handler", from: r.route, target: r.handler, line: r.line });
    }
  } else if (type.language === "sql") {
    symbols = extractSqlTables(text, lines).symbols;
  } else if (type.language === "prisma") {
    const ex = extractPrisma(lines);
    symbols = ex.symbols;
    for (const r of ex.references) edges.push({ kind: "reference", from: r.from, target: r.name, line: r.line });
  }

  if (type.ci) symbols = [...symbols, ...extractCiJobs(type.ci, filePath, text, lines).symbols];

  if (type.manifest) {
    const mod = parseManifest(type.manifest, filePath, text, ctx.repoName);
    if (mod) {
      const content = lines.slice(0, 200).join("\n").slice(0, 4000);
      const index = symbols.length;
      symbols = [
        ...symbols,
        {
          name: mod.name,
          kind: "module",
          startLine: 1,
          endLine: Math.max(1, lineCount),
          content,
          // e.g. `npm module @acme/shop (workspaces: packages/*)`
          signature: `${mod.ecosystem} module ${mod.name}${mod.workspaces.length ? ` (workspaces: ${mod.workspaces.join(", ")})` : ""}`.slice(0, 200),
          qualifiedName: mod.name,
          exported: true,
          parent: null,
        },
      ];
      for (const d of mod.dependencies) edges.push({ kind: "depends_on", from: index, target: d.name, line: 1 });
      for (const m of mod.localModules) edges.push({ kind: "depends_on", from: index, target: m, line: 1 });
      dependencies = mod.dependencies;
    }
  }

  if (symbols.some((s) => s.kind === "route")) tags.add("route");
  if (symbols.some((s) => s.kind === "table" || s.kind === "model")) tags.add("schema");

  let chunks: Chunk[];
  if (type.category === "doc") chunks = chunkDoc(lines, type.language);
  else if (type.category === "config") chunks = chunkConfig(lines);
  else chunks = chunkCode(lines, symbols.filter((s) => s.parent === null && s.kind !== "route"));

  return { language: type.language, tags: [...tags].sort(), lineCount, symbols, edges: capEdges(edges), chunks, dependencies };
}
