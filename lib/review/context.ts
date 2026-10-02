import { aliasedTable, and, eq, inArray, notInArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@/lib/db";
import { edges, files, symbols } from "@/lib/db/schema";
import { parseSource, type ParsedSymbol } from "@/lib/indexer/parser";
import { searchSymbols } from "@/lib/indexer/search";
import type { EmbeddingProvider } from "@/lib/llm";
import { addedRanges, type FileDiff } from "./diff";

export type Relation = "caller" | "callee" | "importer" | "similar";

export interface ChangedSymbol extends ParsedSymbol {
  path: string;
  /** Names this symbol calls (from the PR head). */
  calls: string[];
}

export interface ImpactedCode {
  relation: Relation;
  name: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  /** The changed symbol or file that links this code to the PR. */
  via: string;
}

export interface ReviewContext {
  changed: ChangedSymbol[];
  impacted: ImpactedCode[];
  /** Top-level components (directories / packages) the change spans. */
  components: string[];
  /** Cross-component call relations among changed and impacted code, in call order. */
  flows: { from: string; to: string; label: string }[];
}

const RELATION_PRIORITY: Relation[] = ["caller", "callee", "importer", "similar"];

/** The component a path belongs to: its first two directory levels (e.g. `services/billing`). */
export function componentOf(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join("/") : "(root)";
}

/**
 * Finds the code a PR touches beyond its diff (R1.4): symbols changed in the
 * PR head, then via the index graph their callers, their callees, the files
 * importing changed files, and semantically similar code via pgvector.
 */
export async function buildReviewContext(
  deps: { db: Db; embedder?: EmbeddingProvider },
  input: {
    orgId: string;
    repoId: number;
    diffs: FileDiff[];
    headContent: Map<string, string>;
    budgetChars?: number;
  },
): Promise<ReviewContext> {
  const { db } = deps;
  const { orgId, repoId } = input;
  const changedPaths = input.diffs.map((d) => d.path);

  // 1. Changed symbols: definitions in the PR head overlapping added lines.
  const changed: ChangedSymbol[] = [];
  for (const d of input.diffs) {
    const src = input.headContent.get(d.path);
    if (src === undefined) continue;
    const parsed = await parseSource(d.path, src);
    if (!parsed) continue;
    const ranges = addedRanges(d);
    parsed.symbols.forEach((s, i) => {
      if (!ranges.some(([a, b]) => a <= s.endLine && b >= s.startLine)) return;
      // Prefer the innermost symbols: skip a container when one of its members also changed.
      changed.push({ ...s, path: d.path, calls: parsed.calls.filter((c) => c.from === i).map((c) => c.name) });
    });
  }
  const innermost = changed.filter(
    (s) => !changed.some((o) => o !== s && o.path === s.path && o.startLine >= s.startLine && o.endLine <= s.endLine && (o.startLine !== s.startLine || o.endLine !== s.endLine)),
  );
  const changedNames = [...new Set(innermost.map((s) => s.name))];

  const changedFileRows = changedPaths.length
    ? await db.select({ id: files.id, path: files.path }).from(files).where(and(eq(files.orgId, orgId), eq(files.repoId, repoId), inArray(files.path, changedPaths)))
    : [];
  const changedFileIds = changedFileRows.map((f) => f.id);
  const notInChanged = (col: AnyPgColumn) => (changedFileIds.length ? notInArray(col, changedFileIds) : undefined);

  const impacted: ImpactedCode[] = [];
  const seen = new Set<string>();
  const push = (item: ImpactedCode) => {
    const key = `${item.path}:${item.startLine}:${item.name}`;
    if (seen.has(key) || changedPaths.includes(item.path)) return;
    seen.add(key);
    impacted.push(item);
  };

  const fromSym = aliasedTable(symbols, "from_sym");
  const fromFile = aliasedTable(files, "from_file");
  const flows: { from: string; to: string; label: string }[] = [];

  // 2. Callers: code outside the diff that calls a changed symbol.
  if (changedNames.length) {
    type CallerRow = { target: string; toPath: string | null; name: string; startLine: number; endLine: number; content: string; path: string };
    const rows: CallerRow[] = await db
      .select({
        target: edges.targetName,
        toPath: files.path,
        name: fromSym.name,
        startLine: fromSym.startLine,
        endLine: fromSym.endLine,
        content: fromSym.content,
        path: fromFile.path,
      })
      .from(edges)
      .innerJoin(fromSym, eq(edges.fromSymbolId, fromSym.id))
      .innerJoin(fromFile, eq(edges.fromFileId, fromFile.id))
      .leftJoin(files, eq(edges.toFileId, files.id))
      .where(
        and(
          eq(edges.orgId, orgId),
          eq(edges.repoId, repoId),
          eq(edges.kind, "call"),
          inArray(edges.targetName, changedNames),
          notInChanged(edges.fromFileId),
        ),
      );
    for (const r of rows) {
      // Only callers that resolve to the changed file (or could not be resolved at all).
      const def = innermost.find((s) => s.name === r.target);
      if (!def || (r.toPath && r.toPath !== def.path)) continue;
      push({ relation: "caller", name: r.name, path: r.path, startLine: r.startLine, endLine: r.endLine, content: r.content, via: `${def.path}:${def.name}` });
      flows.push({ from: componentOf(r.path), to: componentOf(def.path), label: `${r.name} → ${def.name}` });
    }
  }

  // 3. Callees: definitions (outside the diff) of what changed symbols call.
  const calleeNames = [...new Set(innermost.flatMap((s) => s.calls))].filter((n) => !changedNames.includes(n));
  if (calleeNames.length) {
    const rows = await db
      .select({ name: symbols.name, startLine: symbols.startLine, endLine: symbols.endLine, content: symbols.content, path: files.path })
      .from(symbols)
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(symbols.orgId, orgId), eq(symbols.repoId, repoId), inArray(symbols.name, calleeNames), notInChanged(symbols.fileId)));
    for (const r of rows) {
      const caller = innermost.find((s) => s.calls.includes(r.name))!;
      push({ relation: "callee", ...r, via: `${caller.path}:${caller.name}` });
      flows.push({ from: componentOf(caller.path), to: componentOf(r.path), label: `${caller.name} → ${r.name}` });
    }
  }

  // 4. Importers: files that import a changed file.
  if (changedFileIds.length) {
    const rows = await db
      .select({ path: fromFile.path, line: edges.line, toPath: files.path })
      .from(edges)
      .innerJoin(fromFile, eq(edges.fromFileId, fromFile.id))
      .innerJoin(files, eq(edges.toFileId, files.id))
      .where(and(eq(edges.orgId, orgId), eq(edges.repoId, repoId), eq(edges.kind, "import"), inArray(edges.toFileId, changedFileIds), notInChanged(edges.fromFileId)));
    for (const r of rows) {
      push({ relation: "importer", name: r.path, path: r.path, startLine: r.line, endLine: r.line, content: `imports ${r.toPath}`, via: r.toPath });
      flows.push({ from: componentOf(r.path), to: componentOf(r.toPath), label: "imports" });
    }
  }

  // 5. Semantically similar code (pgvector), e.g. sibling implementations of the same pattern.
  if (deps.embedder && innermost.length) {
    const [query] = await deps.embedder.embed([innermost.map((s) => `${s.kind} ${s.name}\n${s.content}`).join("\n\n").slice(0, 8000)]);
    if (query) {
      for (const hit of await searchSymbols(db, { orgId, repoId }, query, 8)) {
        if (changedNames.includes(hit.name)) continue;
        push({ relation: "similar", name: hit.name, path: hit.path, startLine: hit.startLine, endLine: hit.endLine, content: hit.content, via: "embedding similarity" });
      }
    }
  }

  // Keep within the context budget, highest-value relations first.
  const budget = input.budgetChars ?? 60_000;
  let used = 0;
  const kept = impacted
    .sort((a, b) => RELATION_PRIORITY.indexOf(a.relation) - RELATION_PRIORITY.indexOf(b.relation))
    .filter((i) => {
      used += i.content.length + i.path.length + 40;
      return used <= budget;
    });

  const components = [...new Set([...changedPaths, ...kept.filter((k) => k.relation !== "similar").map((k) => k.path)].map(componentOf))].sort();
  const uniqueFlows = flows.filter((f, i) => f.from !== f.to && flows.findIndex((g) => g.from === f.from && g.to === f.to && g.label === f.label) === i);
  return { changed: innermost, impacted: kept, components, flows: uniqueFlows };
}
