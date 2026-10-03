/**
 * Demo / local mode guard (R6.22). The local git host is a development aid: it is only available when DEMO_MODE is on,
 * and never when NODE_ENV=production unless DEMO_MODE_ALLOW_PRODUCTION is also set. Every entry point (the host
 * registry, `pnpm demo`, the local pull request pages) checks it, so a production deployment cannot reach it by
 * accident.
 */
import { localModeEnv, type LocalModeEnv } from "@/lib/env";

export class LocalModeDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModeDisabledError";
  }
}

/** Why local mode is off for `e`, or null when it is on. */
export function localModeBlocker(e: Pick<LocalModeEnv, "NODE_ENV" | "DEMO_MODE" | "DEMO_MODE_ALLOW_PRODUCTION">): string | null {
  if (!e.DEMO_MODE) return "Demo / local mode is off. Set DEMO_MODE=true (development only) to use the local git host.";
  if (e.NODE_ENV === "production" && !e.DEMO_MODE_ALLOW_PRODUCTION) {
    return "Demo / local mode is refused when NODE_ENV=production. It is a development aid; set DEMO_MODE_ALLOW_PRODUCTION=true only if you really mean it.";
  }
  return null;
}

/** Whether local mode is on for the given (default: process) environment. */
export function localModeEnabled(source: Record<string, string | undefined> = process.env): boolean {
  return localModeBlocker(localModeEnv(source)) === null;
}

/** The local mode settings, or a {@link LocalModeDisabledError} explaining why local mode is off. */
export function requireLocalMode(source: Record<string, string | undefined> = process.env): LocalModeEnv {
  const e = localModeEnv(source);
  const blocker = localModeBlocker(e);
  if (blocker) throw new LocalModeDisabledError(blocker);
  return e;
}
