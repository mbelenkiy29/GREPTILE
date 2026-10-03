/**
 * The local `openreview-mcp` server's view of an OpenReview server: REST API v1 over HTTP with an API key, and the
 * configuration that says which server and key to use.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { OpenReviewApiError, queryString, type OpenReviewApi } from "./tools.js";

export interface OpenReviewConfig {
  /** The server's origin, e.g. `https://review.example.com`. */
  url: string;
  token: string;
  /** Where the settings came from, for error messages (never the token). */
  source: "env" | "config file";
}

/** `or_live_` followed by 43 base64url characters. */
export const API_KEY_PATTERN = /^or_live_[A-Za-z0-9_-]{43}$/;

/** The CLI's config file: `$XDG_CONFIG_HOME/openreview/config.json`, default `~/.config/openreview/config.json`. */
export function configFilePath(env: Record<string, string | undefined>, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(base, "openreview", "config.json");
}

const configFileSchema = z.looseObject({
  url: z.string().optional(),
  server: z.string().optional(),
  serverUrl: z.string().optional(),
  token: z.string().optional(),
});

export class ConfigError extends Error {}

function normalizeUrl(raw: string, where: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError(`${where} is not a URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError(`${where} must be an http(s) URL.`);
  return u.origin + u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/**
 * Which server and API key to use: `OPENREVIEW_URL` + `OPENREVIEW_TOKEN` from the environment (each one overrides the
 * file), else the `openreview` CLI's config file. Throws {@link ConfigError} with setup instructions when neither has
 * both.
 */
export async function resolveConfig(
  env: Record<string, string | undefined>,
  read: (file: string) => Promise<string> = (f) => readFile(f, "utf8"),
  home?: string,
): Promise<OpenReviewConfig> {
  let fileUrl: string | undefined;
  let fileToken: string | undefined;
  const file = configFilePath(env, home);
  try {
    const parsed = configFileSchema.safeParse(JSON.parse(await read(file)));
    if (parsed.success) {
      fileUrl = parsed.data.url ?? parsed.data.server ?? parsed.data.serverUrl;
      fileToken = parsed.data.token;
    }
  } catch {
    // No config file (or not JSON): the environment must provide everything.
  }
  const envUrl = env.OPENREVIEW_URL?.trim() || undefined;
  const envToken = env.OPENREVIEW_TOKEN?.trim() || undefined;
  const url = envUrl ?? fileUrl;
  const token = envToken ?? fileToken;
  if (!url || !token) {
    throw new ConfigError(
      `OpenReview is not configured. Set OPENREVIEW_URL (your server, e.g. https://review.example.com) and OPENREVIEW_TOKEN (an API key from Settings → API keys), or run \`openreview login\` (config file: ${file}).`,
    );
  }
  if (!API_KEY_PATTERN.test(token)) throw new ConfigError("OPENREVIEW_TOKEN is not an OpenReview API key (expected or_live_ followed by 43 characters).");
  return { url: normalizeUrl(url, envUrl ? "OPENREVIEW_URL" : `The server URL in ${file}`), token, source: envUrl && envToken ? "env" : "config file" };
}

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export interface RestApiOptions {
  config: Pick<OpenReviewConfig, "url" | "token">;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  userAgent?: string;
}

/** REST API v1 of a remote OpenReview server, authenticated with the API key. */
export function restApi(opts: RestApiOptions): OpenReviewApi {
  const doFetch = opts.fetch ?? fetch;
  const base = `${opts.config.url.replace(/\/+$/, "")}/api/v1`;
  return {
    async request(method, apiPath, { query, body } = {}) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opts.config.token}`,
        accept: "application/json",
        "user-agent": opts.userAgent ?? "openreview-mcp",
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await doFetch(`${base}${apiPath}${queryString(query)}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
          redirect: "error",
        });
      } catch (err) {
        throw new OpenReviewApiError(0, "network_error", `${method} ${base}${apiPath} failed (${err instanceof Error ? err.message : String(err)}).`);
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const e = errorBody.safeParse(json);
        if (e.success) throw new OpenReviewApiError(res.status, e.data.error.code, e.data.error.message);
        throw new OpenReviewApiError(res.status, "http_error", `The server answered HTTP ${res.status} for ${method} ${apiPath}. Is OPENREVIEW_URL an OpenReview server?`);
      }
      if (json === null) throw new OpenReviewApiError(res.status, "bad_response", `The server's answer to ${method} ${apiPath} is not JSON. Is OPENREVIEW_URL an OpenReview server?`);
      return json;
    },
  };
}
