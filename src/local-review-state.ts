import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { agentStateSchema, type AgentHooks, type AgentState } from "./engine/agent";

// Saved state for interrupted local agentic reviews (`openreview review --resume`). One file per
// checkout and base commit in the OS cache directory, owner-only. The state is used only when it was
// saved for the current HEAD; if the head moved, it is discarded and the review starts over.
export function cacheDirectory(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "openreview");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "openreview", "cache");
  return path.join(env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, ".cache"), "openreview");
}
export function stateFile(directory: string, root: string, baseSha: string) {
  return path.join(directory, `agent-state-${createHash("sha256").update(`${root}\0${baseSha}`).digest("hex").slice(0, 24)}.json`);
}

export type ResumeOutcome = "fresh" | "resumed" | "restarted";
export function localAgentState(file: string, options: { resume: boolean; headSha: string }) {
  let outcome: ResumeOutcome = "fresh";
  const hooks: AgentHooks = {
    async load(): Promise<AgentState | null> {
      if (!options.resume) return null;
      let saved: AgentState;
      try { saved = agentStateSchema.parse(JSON.parse(await readFile(file, "utf8"))) as AgentState; }
      catch { return null; }
      if (saved.headSha !== options.headSha || saved.done) { outcome = "restarted"; await rm(file, { force: true }); return null; }
      outcome = "resumed";
      return saved;
    },
    async save(state: AgentState) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, file);
    },
  };
  return { hooks, outcome: () => outcome, clear: () => rm(file, { force: true }) };
}
