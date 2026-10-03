import { authEnv, type AuthEnv } from "@/lib/env";
import type { CookieConfig } from "./cookies";

/** Everything the auth route handlers need from the environment, injected so tests can supply their own. */
export interface AuthConfig extends CookieConfig {
  appSecret: string;
  /** Web origin of GitHub (OAuth authorize / token endpoints, App install pages). */
  githubWebUrl: string;
  /** REST API base (`/user`, `/user/emails`, `/user/installations`). */
  githubApiUrl: string;
  githubClientId?: string;
  githubClientSecret?: string;
  devLogin: boolean;
}

export function authConfig(e: AuthEnv = authEnv()): AuthConfig {
  return {
    appUrl: e.APP_URL.replace(/\/$/, ""),
    nodeEnv: e.NODE_ENV,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    appSecret: e.APP_SECRET,
    githubWebUrl: e.GITHUB_WEB_URL.replace(/\/$/, ""),
    githubApiUrl: e.GITHUB_API_URL.replace(/\/$/, ""),
    githubClientId: e.GITHUB_APP_CLIENT_ID,
    githubClientSecret: e.GITHUB_APP_CLIENT_SECRET,
    devLogin: e.AUTH_DEV_LOGIN,
  };
}

/**
 * Dev login is for local development and Playwright only. Checked on every request against both the parsed config
 * and the live `NODE_ENV`, so a production process can never enable it.
 */
export function devLoginAllowed(config: Pick<AuthConfig, "devLogin" | "nodeEnv">, runtimeNodeEnv = process.env.NODE_ENV): boolean {
  return config.devLogin && config.nodeEnv !== "production" && runtimeNodeEnv !== "production";
}

/** Absolute URL on the app's public origin. */
export function appUrl(config: Pick<AuthConfig, "appUrl">, path: string): string {
  return new URL(path, `${config.appUrl}/`).toString();
}

export const GITHUB_CALLBACK_PATH = "/api/auth/github/callback";
