/** Upstream request timeout in seconds (REQUEST_TIMEOUT, default 30). */
export function requestTimeout(env: Record<string, string | undefined>): number {
  const seconds = Number(env.REQUEST_TIMEOUT ?? 30);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
}
