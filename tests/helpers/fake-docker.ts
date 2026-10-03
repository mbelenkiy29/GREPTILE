import type { DockerRequest, DockerResponse, DockerTransport } from "@/lib/sandbox/transport";

export interface RecordedDockerCall {
  method: string;
  path: string;
  query: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  /** Bytes of an uploaded tar body. */
  tar?: Buffer;
}

/** What a command run through exec does in the fake engine. */
export interface FakeCommand {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Never finishes on its own (until the request is aborted). */
  hang?: boolean;
}

function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function response(status: number, body: unknown = undefined): DockerResponse {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    body: (async function* () {
      if (bytes.length) yield bytes;
    })(),
  };
}

/**
 * An in-memory Docker Engine API for sandbox tests: records every request and answers the calls the sandbox makes.
 * Commands are matched by their exact text (`commands`); unknown commands exit 0 with no output.
 */
export class FakeDocker implements DockerTransport {
  readonly calls: RecordedDockerCall[] = [];
  readonly images = new Set<string>(["node:22-bookworm-slim"]);
  commands = new Map<string, FakeCommand>();
  /** Networks the container reports after a disconnect (empty = offline). */
  networksAfterDisconnect: Record<string, unknown> = {};
  /** Status for container create (e.g. 500 to simulate an engine failure). */
  createStatus = 201;
  private execs = new Map<string, string>();
  private nextExec = 0;

  /** Calls matching `method path` (path may be a prefix ending in `*`). */
  find(method: string, path: string): RecordedDockerCall[] {
    return this.calls.filter((c) => c.method === method && (path.endsWith("*") ? c.path.startsWith(path.slice(0, -1)) : c.path === path));
  }

  async request(req: DockerRequest): Promise<DockerResponse> {
    const call: RecordedDockerCall = { method: req.method, path: req.path, query: { ...req.query } };
    if (req.json !== undefined) call.json = JSON.parse(JSON.stringify(req.json));
    if (req.tar) {
      const chunks: Buffer[] = [];
      for await (const c of req.tar) chunks.push(Buffer.from(c));
      call.tar = Buffer.concat(chunks);
    }
    this.calls.push(call);
    if (req.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const { method, path } = req;

    if (method === "GET" && path.startsWith("/images/")) {
      const name = path.slice("/images/".length, -"/json".length);
      return this.images.has(name) ? response(200, { Id: "sha256:1" }) : response(404, { message: "No such image" });
    }
    if (method === "POST" && path === "/images/create") {
      this.images.add(String(req.query?.fromImage));
      return response(200, '{"status":"Pulling"}\n{"status":"Done"}\n');
    }
    if (method === "POST" && path === "/volumes/create") return response(201, { Name: (req.json as { Name: string }).Name });
    if (method === "POST" && path === "/containers/create") {
      return this.createStatus === 201 ? response(201, { Id: "c0ffee".repeat(10) + "abcd" }) : response(this.createStatus, { message: "engine exploded" });
    }
    if (method === "POST" && /^\/containers\/[a-z0-9-]+\/start$/.test(path)) return response(204);
    if (method === "PUT" && /\/archive$/.test(path)) return response(200);
    if (method === "POST" && /^\/containers\/[a-z0-9-]+\/exec$/.test(path)) {
      const id = (++this.nextExec).toString(16).padStart(12, "e");
      this.execs.set(id, (req.json as { Cmd: string[] }).Cmd[2]!);
      return response(201, { Id: id });
    }
    if (method === "POST" && /^\/exec\/[a-f0-9]+\/start$/.test(path)) {
      const id = path.split("/")[2]!;
      const cmd = this.commands.get(this.execs.get(id)!) ?? {};
      const signal = req.signal;
      return {
        status: 200,
        body: (async function* () {
          if (cmd.stdout) yield frame(1, cmd.stdout);
          if (cmd.stderr) yield frame(2, cmd.stderr);
          if (cmd.hang) {
            await new Promise<void>((_, reject) => {
              if (signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
          }
        })(),
      };
    }
    if (method === "GET" && /^\/exec\/[a-f0-9]+\/json$/.test(path)) {
      const id = path.split("/")[2]!;
      const cmd = this.commands.get(this.execs.get(id)!) ?? {};
      return response(200, { Running: false, ExitCode: cmd.exitCode ?? 0 });
    }
    if (method === "POST" && /^\/networks\/[^/]+\/disconnect$/.test(path)) return response(200);
    if (method === "GET" && /^\/containers\/[a-z0-9-]+\/json$/.test(path)) return response(200, { NetworkSettings: { Networks: this.networksAfterDisconnect } });
    if (method === "POST" && /\/kill$/.test(path)) return response(204);
    if (method === "DELETE" && path.startsWith("/containers/")) return response(204);
    if (method === "DELETE" && path.startsWith("/volumes/")) return response(204);
    return response(404, { message: `fake docker: no route for ${method} ${path}` });
  }
}

/** The commands run through exec, in order. */
export function execCommands(docker: FakeDocker): string[] {
  return docker.find("POST", "/containers/*").filter((c) => c.path.endsWith("/exec")).map((c) => (c.json as { Cmd: string[] }).Cmd[2]!);
}
