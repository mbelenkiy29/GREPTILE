/**
 * Real Docker smoke test for the sandbox. Runs only when SANDBOX_DOCKER_HOST points at a Docker engine (feature
 * coverage comes from the fake-engine tests; this one checks the engine accepts the configuration).
 */
import { describe, expect, test } from "vitest";
import { archiveTree } from "@/lib/indexer/git";
import { sandboxEnv } from "@/lib/env";
import { DockerSandbox } from "@/lib/sandbox/docker";
import { httpDockerTransport } from "@/lib/sandbox/transport";
import { FixtureRepo } from "./helpers/fixture-repo";

const host = process.env.SANDBOX_DOCKER_HOST;

describe.skipIf(!host)("sandbox on a real Docker engine", () => {
  test("runs the test command offline as a non-root user on a read-only root", { timeout: 300_000 }, async () => {
    const env = sandboxEnv();
    const repo = new FixtureRepo();
    const sha = repo.commit({ "check.sh": "id -u > /dev/stderr\nwget -q -T 3 -O - http://example.com && exit 9\ntouch /etc/x 2>/dev/null && exit 8\ncat hello.txt\n", "hello.txt": "hello from the sandbox\n" });
    const sandbox = new DockerSandbox(httpDockerTransport(host!), { cpus: 1, memoryMb: 512, workdirMb: 128, maxOutputBytes: 64 * 1024 });
    try {
      const result = await sandbox.run({
        image: env.SANDBOX_IMAGE,
        install: null,
        test: "sh check.sh",
        env: {},
        network: "none",
        timeoutMs: 120_000,
        source: () => archiveTree(repo.dir, sha),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("passed");
      expect(result.output).toContain("hello from the sandbox");
      expect(result.output).toContain("1000");
    } finally {
      repo.cleanup();
    }
  });

  test("kills a run that exceeds its wall-clock limit", { timeout: 120_000 }, async () => {
    const env = sandboxEnv();
    const repo = new FixtureRepo();
    const sha = repo.commit({ "README.md": "slow\n" });
    const sandbox = new DockerSandbox(httpDockerTransport(host!), { cpus: 1, memoryMb: 256, workdirMb: 64, maxOutputBytes: 16 * 1024 });
    try {
      const result = await sandbox.run({ image: env.SANDBOX_IMAGE, install: null, test: "echo started; sleep 60", env: {}, network: "none", timeoutMs: 4_000, source: () => archiveTree(repo.dir, sha) });
      expect(result.status).toBe("timeout");
      expect(result.output).toContain("started");
      expect(result.durationMs).toBeLessThan(30_000);
    } finally {
      repo.cleanup();
    }
  });
});
