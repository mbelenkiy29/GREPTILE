/**
 * Entity extraction for files tree-sitter does not parse (R6.3): SQL `CREATE TABLE`, Prisma models, and CI jobs
 * (GitHub Actions, GitLab CI, CircleCI, Jenkins, Azure Pipelines).
 */
import path from "node:path/posix";
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode, type Pair } from "yaml";
import type { CiType } from "./filetypes";
import { signatureOf, type NamedEdge, type ParsedSymbol, type SymbolKind } from "./parser";

const MAX_SYMBOL_CHARS = 4000;

export interface Extracted {
  symbols: ParsedSymbol[];
  references: NamedEdge[];
}

function symbol(
  lines: readonly string[],
  s: { name: string; kind: SymbolKind; startLine: number; endLine: number; qualifiedName?: string; parent?: number | null; exported?: boolean },
): ParsedSymbol {
  const content = lines.slice(s.startLine - 1, s.endLine).join("\n").slice(0, MAX_SYMBOL_CHARS);
  return {
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: Math.max(s.startLine, s.endLine),
    content,
    signature: signatureOf(content),
    qualifiedName: s.qualifiedName ?? s.name,
    exported: s.exported ?? false,
    parent: s.parent ?? null,
  };
}

function lineAt(offset: number, lineStarts: number[]): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

// ---------------------------------------------------------------------------------------------------------------
// SQL

/** Blanks out comments and string literals (keeping offsets) so keywords inside them are ignored. */
function maskSql(text: string): string {
  return text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, " "));
}

const CREATE_TABLE =
  /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+|virtual\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:[`"[]?[\w$]+[`"\]]?\s*\.\s*)?[`"[]?[\w$]+[`"\]]?)/gi;

export function extractSqlTables(text: string, lines: readonly string[]): Extracted {
  const masked = maskSql(text);
  const starts = lineStartsOf(text);
  const symbols: ParsedSymbol[] = [];
  for (const m of masked.matchAll(CREATE_TABLE)) {
    const name = m[1]!.split(".").pop()!.replace(/[`"[\]\s]/g, "");
    const at = m.index!;
    // The definition ends at the parenthesis that closes the column list (or the statement's semicolon).
    let depth = 0;
    let end = masked.indexOf(";", at);
    for (let i = at + m[0].length; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      } else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    symbols.push(symbol(lines, { name, kind: "table", startLine: lineAt(at, starts), endLine: lineAt(end < 0 ? text.length - 1 : end, starts), exported: true }));
  }
  return { symbols, references: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Prisma

const PRISMA_SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported"]);

export function extractPrisma(lines: readonly string[]): Extracted {
  const symbols: ParsedSymbol[] = [];
  const references: NamedEdge[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*(model|enum|view|type)\s+(\w+)\s*\{/.exec(lines[i]!);
    if (!head) continue;
    let end = i;
    while (end < lines.length - 1 && !/^\s*\}/.test(lines[end]!)) end++;
    const kind: SymbolKind = head[1] === "enum" ? "enum" : head[1] === "type" ? "type" : "model";
    const modelIndex = symbols.length;
    symbols.push(symbol(lines, { name: head[2]!, kind, startLine: i + 1, endLine: end + 1, exported: true }));
    for (let j = i + 1; j < end; j++) {
      const line = lines[j]!;
      const map = /@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(line);
      if (map) symbols.push(symbol(lines, { name: map[1]!, kind: "table", startLine: j + 1, endLine: j + 1, parent: modelIndex, exported: true }));
      const field = /^\s*\w+\s+([A-Z]\w*)(?:\[\])?\??(?:\s|$)/.exec(line);
      if (field && kind === "model" && !PRISMA_SCALARS.has(field[1]!)) references.push({ name: field[1]!, line: j + 1, from: modelIndex });
    }
    if (kind === "model" && !symbols.some((s, k) => k > modelIndex && s.kind === "table" && s.parent === modelIndex)) {
      // Without @@map the table is named after the model.
      symbols.push(symbol(lines, { name: head[2]!, kind: "table", startLine: i + 1, endLine: i + 1, parent: modelIndex, exported: true }));
    }
    i = end;
  }
  return { symbols, references };
}

// ---------------------------------------------------------------------------------------------------------------
// CI

interface JobSpan {
  name: string;
  startOffset: number;
  endOffset: number;
}

function keyOf(pair: Pair): string | null {
  return isScalar(pair.key) ? String(pair.key.value) : null;
}

function mapPairs(node: unknown): Pair[] {
  return isMap(node) ? (node.items as Pair[]) : [];
}

function pairRange(pair: Pair): [number, number] | null {
  const key = pair.key as YamlNode | null;
  const value = pair.value as YamlNode | null;
  const start = key?.range?.[0];
  const end = value?.range?.[2] ?? key?.range?.[2];
  return start === undefined || end === undefined ? null : [start, end];
}

function jobsFromMap(jobs: unknown, filter: (pair: Pair) => boolean = () => true): JobSpan[] {
  const out: JobSpan[] = [];
  for (const pair of mapPairs(jobs)) {
    const name = keyOf(pair);
    const range = pairRange(pair);
    if (name && range && filter(pair)) out.push({ name, startOffset: range[0], endOffset: range[1] });
  }
  return out;
}

const GITLAB_RESERVED = new Set(["stages", "variables", "image", "services", "before_script", "after_script", "cache", "include", "default", "workflow"]);

function azureJobs(seq: unknown): JobSpan[] {
  const out: JobSpan[] = [];
  if (!isSeq(seq)) return out;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const id = item.get("job") ?? item.get("deployment");
    const range = (item as YamlNode).range;
    if (typeof id === "string" && range) out.push({ name: id, startOffset: range[0], endOffset: range[2] });
  }
  return out;
}

export function extractCiJobs(type: CiType, filePath: string, text: string, lines: readonly string[]): Extracted {
  const starts = lineStartsOf(text);
  let jobs: JobSpan[] = [];
  let workflow = path.basename(filePath).replace(/\.ya?ml$/i, "");

  if (type === "jenkins") {
    const stageRe = /\bstage\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const found = [...text.matchAll(stageRe)];
    // A stage runs until the line before the next stage.
    jobs = found.map((m, i) => {
      const next = found[i + 1]?.index;
      return { name: m[1]!, startOffset: m.index!, endOffset: next === undefined ? text.length : text.lastIndexOf("\n", next) };
    });
  } else {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, uniqueKeys: false });
    const root = doc.contents;
    if (isMap(root)) {
      const wfName = root.get("name");
      if (typeof wfName === "string") workflow = wfName;
      if (type === "github" || type === "circleci") jobs = jobsFromMap(root.get("jobs", true));
      if (type === "gitlab") {
        jobs = jobsFromMap(root, (pair) => {
          const name = keyOf(pair) ?? "";
          if (GITLAB_RESERVED.has(name) || name.startsWith(".")) return false;
          return isMap(pair.value) && ["script", "trigger", "extends", "run"].some((k) => (pair.value as { has(k: string): boolean }).has(k));
        });
      }
      if (type === "azure") {
        jobs = azureJobs(root.get("jobs", true));
        const stages = root.get("stages", true);
        if (isSeq(stages)) for (const st of stages.items) if (isMap(st)) jobs.push(...azureJobs(st.get("jobs", true)));
        const steps = root.get("steps", true) as YamlNode | undefined;
        if (jobs.length === 0 && steps?.range) jobs.push({ name: "default", startOffset: steps.range[0], endOffset: steps.range[2] });
      }
    }
  }

  const symbols = jobs.map((j) =>
    symbol(lines, {
      name: j.name,
      kind: "ci_job",
      startLine: lineAt(j.startOffset, starts),
      endLine: lineAt(Math.max(j.startOffset, j.endOffset - 1), starts),
      qualifiedName: `${workflow}/${j.name}`,
    }),
  );
  return { symbols, references: [] };
}
