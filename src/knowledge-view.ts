/** Keep partial retrieval failures distinct from a successful empty search. */
export async function knowledgeView<R extends { _id: string }, E>(
  repositories: R[],
  filters: { team?: string; repository?: string; q?: string },
  read: (repository: R, search: string | undefined) => Promise<E[]>,
) {
  const params = new URLSearchParams();
  for (const key of ["team", "repository", "q"] as const) {
    if (filters[key] !== undefined) params.set(key, filters[key]);
  }
  const retryUrl = `/dashboard/memory/knowledge${params.size ? `?${params}` : ""}`;
  const searchError = (filters.q?.length ?? 0) > 200;
  const results = searchError ? [] : await Promise.all(
    repositories.filter(repo => !filters.repository || repo._id === filters.repository).map(async repo => {
      try {
        return { repo, failed: false, entries: await read(repo, filters.q) };
      } catch {
        // Errors may include private backend details; expose only a recoverable state.
        return { repo, failed: true, entries: [] as E[] };
      }
    }),
  );
  const incomplete = results.some(result => result.failed);
  const count = results.reduce((total, result) => total + result.entries.length, 0);
  return { results, retryUrl, searchError, incomplete, count, empty: !searchError && !incomplete && count === 0 };
}
