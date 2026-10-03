/** `openreview login`, `logout`, and `whoami` (R3.5). */
import { z } from "zod";
import { ApiClient } from "../api";
import { configPath, deleteConfig, loadConfig, normalizeServer, resolveAuth, saveConfig, TOKEN_PATTERN } from "../config";
import { authedClient, meSchema, type Ctx, type Me } from "../context";
import { CliError, scrubSecrets } from "../errors";

export interface LoginOptions {
  server?: string;
  token?: string;
  /** Do not try to open the browser. */
  browser?: boolean;
}

const deviceStartSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
const tokenSchema = z.object({ access_token: z.string().regex(TOKEN_PATTERN), organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }) });
const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional(), interval: z.number().optional() });

async function serverFor(ctx: Ctx, explicit: string | undefined): Promise<string> {
  const raw = explicit ?? ctx.io.env.OPENREVIEW_URL ?? (await loadConfig(ctx.io).catch(() => null))?.server;
  if (!raw) throw new CliError("Which OpenReview server? Pass --server https://your-openreview.example.com (or set OPENREVIEW_URL).");
  return normalizeServer(raw);
}

/** Runs the device-code flow: prints the code and URL, opens the browser, and polls until approved. */
async function deviceLogin(ctx: Ctx, api: ApiClient, opts: LoginOptions): Promise<string> {
  const startRes = await api.raw("POST", "/api/cli/device", { body: { clientHost: ctx.io.hostname() } });
  if (startRes.status === 404) throw new CliError(`${api.server} does not support CLI login.`, "Create an API key under Settings → API keys and run `openreview login --token <key>`.");
  if (!startRes.ok) {
    const body = oauthErrorSchema.safeParse(await startRes.json().catch(() => null));
    throw new CliError(`Couldn't start the login: ${body.success ? (body.data.error_description ?? body.data.error) : `HTTP ${startRes.status}`}.`);
  }
  const start = deviceStartSchema.safeParse(await startRes.json().catch(() => null));
  if (!start.success) throw new CliError(`${api.server} answered the login request unexpectedly. Is it an OpenReview server?`);
  const s = start.data;
  ctx.io.stderr(`\nTo sign in, open:\n\n  ${s.verification_uri_complete}\n\nand confirm the code: ${s.user_code}\n\n`);
  if (opts.browser !== false && (await ctx.io.openUrl(s.verification_uri_complete))) ctx.io.stderr("(Opened your browser.)\n");
  ctx.io.stderr("Waiting for approval… (Ctrl-C to cancel)\n");

  let interval = Math.max(1, s.interval);
  const deadline = ctx.io.now().getTime() + s.expires_in * 1000;
  while (ctx.io.now().getTime() < deadline) {
    await ctx.io.sleep(interval * 1000);
    const res = await api.raw("POST", "/api/cli/token", { body: { device_code: s.device_code } });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const t = tokenSchema.safeParse(body);
      if (!t.success) throw new CliError("The server's answer to the login did not contain a valid API key.");
      return t.data.access_token;
    }
    const e = oauthErrorSchema.safeParse(body);
    const code = e.success ? e.data.error : `http_${res.status}`;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval = Math.max(interval + 5, e.success && e.data.interval ? e.data.interval : 0);
      continue;
    }
    if (code === "access_denied") throw new CliError(`The login was denied${e.success && e.data.error_description ? `: ${e.data.error_description}` : "."}`);
    if (code === "expired_token") throw new CliError("The login code expired before it was approved.", "Run `openreview login` again.");
    throw new CliError(`The login failed: ${scrubSecrets(e.success ? (e.data.error_description ?? code) : `HTTP ${res.status}`)}`);
  }
  throw new CliError("The login code expired before it was approved.", "Run `openreview login` again.");
}

async function readToken(ctx: Ctx, raw: string): Promise<string> {
  const token = (raw === "-" ? await ctx.io.readStdin() : raw).trim();
  if (!TOKEN_PATTERN.test(token)) throw new CliError("That is not an OpenReview API key (keys start with or_live_).", "Create one under Settings → API keys in the dashboard.");
  return token;
}

export async function login(ctx: Ctx, opts: LoginOptions): Promise<void> {
  const server = await serverFor(ctx, opts.server);
  const host = new URL(server).hostname;
  if (server.startsWith("http://") && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    ctx.warn(`${server} is not HTTPS: your API key will travel unencrypted.`);
  }
  const token = opts.token !== undefined ? await readToken(ctx, opts.token) : await deviceLogin(ctx, new ApiClient(ctx.io, server, null), opts);
  // Confirm the key works (and learn its org) before saving it.
  const me = await new ApiClient(ctx.io, server, token).json("GET", "/api/v1/me", meSchema);
  const file = await saveConfig(ctx.io, { server, token, organization: me.organization, savedAt: ctx.io.now().toISOString() });
  const key = me.apiKey ? ` with key ${me.apiKey.name} (or_live_${me.apiKey.prefix}…)` : "";
  ctx.out(`Logged in to ${me.organization.name} on ${server}${key}.`);
  ctx.note(`Credentials saved to ${file} (readable only by you).`);
  if (ctx.io.env.OPENREVIEW_TOKEN) ctx.warn("OPENREVIEW_TOKEN is set and overrides the saved key.");
}

export async function logout(ctx: Ctx): Promise<void> {
  const config = await loadConfig(ctx.io).catch(() => null);
  const removed = await deleteConfig(ctx.io);
  if (!removed) {
    ctx.out("You were not logged in.");
  } else {
    ctx.out(`Logged out${config ? ` of ${config.server}` : ""}; removed ${configPath(ctx.io)}.`);
    ctx.note("The API key itself stays valid until it expires; revoke it under Settings → API keys if you no longer need it.");
  }
  if (ctx.io.env.OPENREVIEW_TOKEN) ctx.warn("OPENREVIEW_TOKEN is still set in your environment.");
}

export function describeMe(me: Me, server: string): string[] {
  return [
    `Server:       ${server}`,
    `Organization: ${me.organization.name} (${me.organization.slug})`,
    me.apiKey ? `API key:      ${me.apiKey.name} (or_live_${me.apiKey.prefix}…)` : `User:         ${me.user?.name ?? "unknown"}`,
    `Scopes:       ${me.scopes.join(", ") || "none"}`,
  ];
}

export async function whoami(ctx: Ctx, opts: { json?: boolean }): Promise<void> {
  const { api, auth } = await authedClient(ctx);
  const me = await api.json("GET", "/api/v1/me", meSchema);
  if (opts.json) {
    ctx.out(JSON.stringify({ server: auth.server, credentials: auth.source, organization: me.organization, apiKey: me.apiKey, user: me.user, scopes: me.scopes }, null, 2));
    return;
  }
  ctx.out([...describeMe(me, auth.server), `Credentials:  ${auth.source === "env" ? "OPENREVIEW_TOKEN" : configPath(ctx.io)}`].join("\n"));
}

/** Not logged in is fine for some commands; this says whether credentials exist without contacting the server. */
export async function hasCredentials(ctx: Ctx): Promise<boolean> {
  return (await resolveAuth(ctx.io)) !== null;
}
