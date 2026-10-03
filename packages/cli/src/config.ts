/**
 * Credentials (R3.5): `~/.config/openreview/config.json` (or `$XDG_CONFIG_HOME/openreview/config.json`), written
 * with 0600 permissions in a 0700 directory. `OPENREVIEW_URL` and `OPENREVIEW_TOKEN` override the file.
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CliError } from "./errors";
import type { CliIo } from "./io";

export const TOKEN_PATTERN = /^or_live_[A-Za-z0-9_-]{43}$/;

const configSchema = z.object({
  server: z.string().url(),
  token: z.string().regex(TOKEN_PATTERN),
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable().optional(),
  savedAt: z.string().optional(),
});
export type StoredConfig = z.infer<typeof configSchema>;

export function configPath(io: CliIo): string {
  const base = io.env.XDG_CONFIG_HOME?.trim() || path.join(io.homedir(), ".config");
  return path.join(base, "openreview", "config.json");
}

/** `https://Host:443/x/` → `https://host/x` (no trailing slash); rejects anything but http(s). */
export function normalizeServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliError(`"${raw}" is not a valid server URL.`, "Use the address of your OpenReview server, e.g. https://openreview.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliError(`The server URL must start with https:// (got ${url.protocol}).`);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export async function loadConfig(io: CliIo): Promise<StoredConfig | null> {
  const file = configPath(io);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`Can't read ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not valid JSON.`, "Run `openreview logout` and `openreview login` to recreate it.");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new CliError(`${file} is not a valid OpenReview config.`, "Run `openreview logout` and `openreview login` to recreate it.");
  return parsed.data;
}

export async function saveConfig(io: CliIo, config: StoredConfig): Promise<string> {
  const file = configPath(io);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing file too.
  await chmod(file, 0o600);
  return file;
}

export async function deleteConfig(io: CliIo): Promise<boolean> {
  const file = configPath(io);
  const exists = await stat(file).then(
    () => true,
    () => false,
  );
  if (exists) await rm(file);
  return exists;
}

export interface Auth {
  server: string;
  token: string;
  /** Where the token came from. */
  source: "env" | "config";
}

/** The server and token to use (env over config), or null when not logged in. */
export async function resolveAuth(io: CliIo, opts: { server?: string } = {}): Promise<Auth | null> {
  const config = await loadConfig(io);
  const envToken = io.env.OPENREVIEW_TOKEN?.trim();
  const serverRaw = opts.server ?? io.env.OPENREVIEW_URL?.trim() ?? config?.server;
  if (envToken) {
    if (!TOKEN_PATTERN.test(envToken)) throw new CliError("OPENREVIEW_TOKEN is not a valid OpenReview API key (it should start with or_live_).");
    if (!serverRaw) throw new CliError("OPENREVIEW_TOKEN is set but no server is: set OPENREVIEW_URL too.");
    return { server: normalizeServer(serverRaw), token: envToken, source: "env" };
  }
  if (!config) return null;
  return { server: normalizeServer(serverRaw ?? config.server), token: config.token, source: "config" };
}

/** Like {@link resolveAuth}, but throws a helpful error when not logged in. */
export async function requireAuth(io: CliIo, opts: { server?: string } = {}): Promise<Auth> {
  const auth = await resolveAuth(io, opts);
  if (!auth) throw new CliError("You're not logged in to an OpenReview server.", "Run `openreview login --server https://your-openreview.example.com`, or set OPENREVIEW_URL and OPENREVIEW_TOKEN.");
  return auth;
}
