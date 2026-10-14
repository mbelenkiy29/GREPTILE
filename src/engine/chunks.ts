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
