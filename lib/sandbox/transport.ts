/**
 * Plain HTTP to the Docker Engine API (R4.5), over a unix socket or TCP. No CLI and no shell is involved: every value
 * travels as JSON or a query parameter. The sandbox depends on the {@link DockerTransport} interface so tests can
 * inject a fake engine.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

/** Engine API version every path is prefixed with (Docker 20.10+). */
export const DOCKER_API_VERSION = "v1.41";

export interface DockerRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path below the version prefix, e.g. `/containers/create`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. */
  json?: unknown;
  /** Raw body (a tar archive), sent as `application/x-tar`. */
  tar?: Readable | AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface DockerResponse {
  status: number;
  /** The body as a stream of chunks (read it once). */
  body: AsyncIterable<Uint8Array>;
}

export interface DockerTransport {
  request(req: DockerRequest): Promise<DockerResponse>;
}

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

/** The response body as text (at most `max` bytes are kept). */
export async function readText(res: DockerResponse, max = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    if (size >= max) continue;
    const b = Buffer.from(chunk);
    chunks.push(b);
    size += b.length;
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, max);
}

/** Throws a {@link DockerApiError} carrying the engine's message unless the status is one of `ok`. */
export async function expectStatus(res: DockerResponse, ok: number[], what: string): Promise<void> {
  if (ok.includes(res.status)) return;
  const text = await readText(res, 4096).catch(() => "");
  let message = text.trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON: keep the text
  }
  throw new DockerApiError(res.status, `${what} failed (HTTP ${res.status})${message ? `: ${message.slice(0, 500)}` : ""}`);
}

export async function readJson<T>(res: DockerResponse): Promise<T> {
  return JSON.parse(await readText(res)) as T;
}

function queryString(query: DockerRequest["query"]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * A transport for `host`: `unix:///path/to/docker.sock` or `tcp://host:port` (plain HTTP; keep the engine on a
 * private network, or reach a remote one through an SSH tunnel to its socket).
 */
export function httpDockerTransport(host: string): DockerTransport {
  const url = new URL(host);
  let target: { socketPath: string } | { host: string; port: number };
  if (url.protocol === "unix:") {
    if (!url.pathname) throw new Error("SANDBOX_DOCKER_HOST: unix:// needs a socket path");
    target = { socketPath: decodeURIComponent(url.pathname) };
  } else if (url.protocol === "tcp:" || url.protocol === "http:") {
    target = { host: url.hostname, port: Number(url.port || 2375) };
  } else {
    throw new Error(`SANDBOX_DOCKER_HOST: unsupported scheme ${url.protocol} (use unix:// or tcp://)`);
  }
  return {
    request(req) {
      return new Promise<DockerResponse>((resolve, reject) => {
        const headers: Record<string, string> = { host: "docker" };
        let payload: string | undefined;
        if (req.json !== undefined) {
          payload = JSON.stringify(req.json);
          headers["content-type"] = "application/json";
          headers["content-length"] = String(Buffer.byteLength(payload));
        } else if (req.tar) {
          headers["content-type"] = "application/x-tar";
        }
        const r = httpRequest(
          { ...target, method: req.method, path: `/${DOCKER_API_VERSION}${req.path}${queryString(req.query)}`, headers, signal: req.signal },
          (res: IncomingMessage) => resolve({ status: res.statusCode ?? 0, body: res }),
        );
        r.on("error", reject);
        if (payload !== undefined) r.end(payload);
        else if (req.tar) {
          void (async () => {
            try {
              for await (const chunk of req.tar!) {
                if (!r.write(chunk)) await new Promise<void>((done) => r.once("drain", () => done()));
              }
              r.end();
            } catch (err) {
              r.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        } else r.end();
      });
    },
  };
}
