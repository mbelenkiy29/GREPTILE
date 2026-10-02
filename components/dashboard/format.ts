export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function githubPrUrl(repoFullName: string, prNumber: number) {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}
