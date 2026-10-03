import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRoute, type ApiDeps } from "@/lib/api/router";
import { V1_ROUTES } from "@/lib/api/v1";
import { pollDeviceToken, startDeviceLogin, type DeviceDeps } from "@/lib/cli/device";
import type { CliIo } from "@/packages/cli/src/io";
import { run } from "@/packages/cli/src/program";

export const CLI_SERVER = "https://review.example.com";

export interface TestIo extends CliIo {
  /** Everything written to stdout / stderr. */
  out: string;
  err: string;
  /** Requests the CLI sent, as `METHOD /path?query`. */
  requests: { method: string; url: string; authorization: string | null; body: unknown }[];
  clock: { ms: number };
  copied: string[];
  opened: string[];
}

/** Dispatches a request to the app's handlers the way Next.js would (v1 route table and the CLI login endpoints). */
export async function dispatch(req: Request, deps: { api?: ApiDeps; device?: DeviceDeps }): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/cli/device" && req.method === "POST" && deps.device) return startDeviceLogin(deps.device, req);
  if (url.pathname === "/api/cli/token" && req.method === "POST" && deps.device) return pollDeviceToken(deps.device, req);
  if (url.pathname.startsWith("/api/v1/") && deps.api) {
    const p = url.pathname.slice("/api/v1".length);
    for (const route of V1_ROUTES) {
      if (route.method !== req.method) continue;
      const names: string[] = [];
      const re = new RegExp(`^${route.path.replace(/\./g, "\\.").replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), "([^/]+)"))}$`);
      const m = re.exec(p);
      if (!m) continue;
      return executeRoute(route, deps.api, req, Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])));
    }
  }
  return Response.json({ error: { code: "not_found", message: "No such route." } }, { status: 404 });
}

/**
 * An in-process CLI environment: a temporary HOME/XDG config dir, captured output, a fake clock that `sleep`
 * advances, and `fetch` routed to the app's handlers (or `fetchImpl`).
 */
export function testIo(opts: {
  cwd: string;
  env?: Record<string, string | undefined>;
  deps?: { api?: ApiDeps; device?: DeviceDeps };
  fetchImpl?: typeof fetch;
  onSleep?: (ms: number, io: TestIo) => Promise<void> | void;
  start?: Date;
  local?: CliIo["local"];
  stdin?: string;
}): TestIo {
  const home = mkdtempSync(path.join(tmpdir(), "or-cli-home-"));
  const clock = { ms: (opts.start ?? new Date("2026-03-01T12:00:00Z")).getTime() };
  const io: TestIo = {
    out: "",
    err: "",
    requests: [],
    clock,
    copied: [],
    opened: [],
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), NO_COLOR: "1", ...opts.env },
    cwd: opts.cwd,
    stdout: (t) => {
      io.out += t;
    },
    stderr: (t) => {
      io.err += t;
    },
    isTTY: false,
    fetch: async (input, init) => {
      const req = new Request(input as string | URL, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      const u = new URL(req.url);
      io.requests.push({ method: req.method, url: `${u.pathname}${u.search}`, authorization: req.headers.get("authorization"), body });
      if (opts.fetchImpl) return opts.fetchImpl(req);
      return dispatch(req, opts.deps ?? {});
    },
    sleep: async (ms) => {
      clock.ms += ms;
      await opts.onSleep?.(ms, io);
    },
    now: () => new Date(clock.ms),
    hostname: () => "dev-laptop",
    homedir: () => home,
    readStdin: async () => opts.stdin ?? "",
    openUrl: async (url) => {
      io.opened.push(url);
      return true;
    },
    copy: async (text) => {
      io.copied.push(text);
      return "pbcopy";
    },
    ...(opts.local ? { local: opts.local } : {}),
  };
  return io;
}

/** Runs `openreview <args>` in-process; returns the exit code with the captured output. */
export async function cli(io: TestIo, ...args: string[]) {
  const before = { out: io.out.length, err: io.err.length };
  const code = await run(args, io);
  return { code, out: io.out.slice(before.out), err: io.err.slice(before.err) };
}
