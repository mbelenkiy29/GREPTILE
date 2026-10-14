export function sourceChunks(
  content: string,
  maximum = 2000,
): { content: string; startLine: number }[] {
  const chunks: { content: string; startLine: number }[] = [];
  let current = "",
    startLine = 1;
  for (const [index, line] of content.split("\n").entries()) {
    if (current && current.length + line.length + 1 > maximum) {
      chunks.push({ content: current, startLine });
      current = "";
      startLine = index + 1;
    }
    if (line.length > maximum) {
      if (current) {
        chunks.push({ content: current, startLine });
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += maximum)
        chunks.push({
          content: line.slice(offset, offset + maximum),
          startLine: index + 1,
        });
      startLine = index + 2;
    } else current += line + "\n";
  }
  if (current.trim()) chunks.push({ content: current, startLine });
  return chunks;
}

export type SemanticChunk = { content: string; startLine: number; endLine: number; symbol?: string };
// Definition-boundary chunks for embeddings: each chunk starts at a definition (from the code
// graph) and runs to the next one; oversized spans and files without definitions fall back to
// line windows. Every line belongs to exactly one chunk.
export function semanticChunks(content: string, definitions: { line: number; name: string }[], maximum = 2000, minimumGap = 3): SemanticChunk[] {
  const lines = content.split("\n"), out: SemanticChunk[] = [];
  // Nested definitions that start within three lines of the previous boundary (a class and its
  // first method) stay in one chunk instead of producing one-line fragments.
  const starts: [number, string][] = [];
  for (const d of definitions.filter((d) => d.line >= 1 && d.line <= lines.length).sort((a, b) => a.line - b.line))
    if (!starts.length || d.line - starts[starts.length - 1][0] >= minimumGap) starts.push([d.line, d.name]);
  const bounds: { start: number; symbol?: string }[] = starts.length && starts[0][0] === 1 ? [] : [{ start: 1 }];
  for (const [line, name] of starts) bounds.push({ start: line, symbol: name });
  for (const [i, bound] of bounds.entries()) {
    const end = (bounds[i + 1]?.start ?? lines.length + 1) - 1;
    const text = lines.slice(bound.start - 1, end).join("\n");
    if (!text.trim()) continue;
    if (text.length <= maximum) { out.push({ content: text, startLine: bound.start, endLine: end, ...(bound.symbol ? { symbol: bound.symbol } : {}) }); continue; }
    for (const piece of sourceChunks(text, maximum)) {
      const startLine = bound.start + piece.startLine - 1, endLine = Math.min(end, startLine + piece.content.replace(/\n$/, "").split("\n").length - 1);
      out.push({ content: piece.content, startLine, endLine, ...(bound.symbol ? { symbol: bound.symbol } : {}) });
    }
  }
  return out;
}
