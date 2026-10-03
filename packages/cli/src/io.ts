/**
 * Everything the CLI touches outside its own code — environment, working directory, terminal, network, clock,
 * browser, clipboard — behind one interface, so commands run in-process in tests with injected fakes.
 */
import { execFile, spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm/types";

export interface CliIo {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdout is an interactive terminal (colors, progress). */
  isTTY: boolean;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
  hostname(): string;
  homedir(): string;
  /** Reads all of stdin (for `--token -`). */
  readStdin(): Promise<string>;
  /** Opens a URL in the default browser; false when that is not possible. */
  openUrl(url: string): Promise<boolean>;
  /** Copies text to the clipboard; returns the tool used, or null when none is available. */
  copy(text: string): Promise<string | null>;
  /** Local mode's model and embedder (tests inject fakes); by default built from the environment. */
  local?: { llm?: LlmProvider; embedder?: EmbeddingProvider | null };
}

function run(cmd: string, args: string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"], detached: input === undefined });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      if (input !== undefined) child.stdin?.end(input);
      else {
        // A browser launcher may keep running; treat a successful spawn as success.
        child.unref();
        setTimeout(() => resolve(true), 300).unref();
      }
    } catch {
      resolve(false);
    }
  });
}

function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [cmd], (err) => resolve(!err));
  });
}

/** Clipboard tools in order of preference per platform. */
const CLIPBOARD: Record<string, [string, string[]][]> = {
  darwin: [["pbcopy", []]],
  win32: [["clip", []]],
  linux: [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ],
};

/** The real process: environment, terminal, network, browser, clipboard. */
export function nodeIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    isTTY: Boolean(process.stdout.isTTY),
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    hostname: () => hostname(),
    homedir: () => homedir(),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    openUrl: async (url) => {
      if (!/^https?:\/\//.test(url)) return false;
      if (process.platform === "darwin") return run("open", [url]);
      if (process.platform === "win32") return run("cmd", ["/c", "start", "", url]);
      return (await which("xdg-open")) ? run("xdg-open", [url]) : false;
    },
    copy: async (text) => {
      for (const [cmd, args] of CLIPBOARD[process.platform] ?? CLIPBOARD.linux!) {
        if ((await which(cmd)) && (await run(cmd, args, text))) return cmd;
      }
      return null;
    },
  };
}
