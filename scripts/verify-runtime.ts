import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import assert from "node:assert/strict";
import { runtimeEvidenceSchema } from "../src/engine/types";
const { values } = parseArgs({ options: { image: { type: "string" } } });
if (!values.image)
  throw new Error(
    "Supply --image with a trusted digest-pinned Node image. Requires Docker.",
  );
const execute = promisify(execFile);
const directory = await mkdtemp(
  path.join(tmpdir(), "openreview-runtime-verification-"),
);
try {
  const git = (...args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory,
    });
  await git("init", "-b", "main");
  await git("config", "user.name", "OpenReview runtime verification");
  await git("config", "user.email", "runtime@example.invalid");
  await writeFile(
    path.join(directory, "check.test.cjs"),
    `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('isolated committed source executes',()=>{assert.equal(process.getuid(),65534);assert.equal(fs.existsSync('/app/.env.local'),false);assert.throws(()=>fs.writeFileSync('/host-access-check','forbidden'));});\n`,
  );
  await git("add", ".");
  await git("commit", "--no-gpg-sign", "-m", "Trusted runtime fixture");
  const { stdout } = await execute(
    process.execPath,
    [
      path.resolve("bin/openreview.mjs"),
      "runtime",
      "--image",
      values.image,
      "--command",
      "node --test check.test.cjs",
      "--timeout",
      "30",
    ],
    { cwd: directory },
  );
  const evidence = runtimeEvidenceSchema.parse(JSON.parse(stdout));
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.timedOut, false);
  assert.match(evidence.output, /isolated committed source executes/);
  assert.equal(
    evidence.headSha,
    (await git("rev-parse", "HEAD")).stdout.trim(),
  );
  await mkdir("reports", { recursive: true });
  await writeFile(
    "reports/runtime-verification.json",
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(
    "Runtime verification passed: committed source executed as an unprivileged user with read-only root, no host env file, bounded resources and captured commit-bound evidence.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
