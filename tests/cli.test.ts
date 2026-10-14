import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
test("installed CLI reviews committed Git changes and emits clean agent JSON with cross-file context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openreview-cli-test-"));
  const contexts: { path: string }[][] = [];
  let invalidOutput = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    contexts.push(JSON.parse(input.messages[1].content).context);
    const result = input.messages[0].content.includes('a summary field')
      ? {
          reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary:
            "A guard was changed and its caller was reviewed; no verified findings in this transport fixture.",
        }
      : { findings: [] };
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(
                invalidOutput ? { findings: "invalid" } : result,
              ),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const git = (...args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory,
    });
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "OpenReview CLI test");
    await git("config", "user.email", "cli-test@example.invalid");
    await writeFile(
      path.join(directory, "auth.ts"),
      "export function allowed(user) { return !!user; }\n",
    );
    await writeFile(
      path.join(directory, "route.ts"),
      "import { allowed } from './auth';\nexport function route(user) { return allowed(user); }\n",
    );
    await git("add", ".");
    await git("commit", "--no-gpg-sign", "-m", "Base");
    await git("checkout", "-b", "feature");
    await writeFile(
      path.join(directory, "auth.ts"),
      "export function allowed(user) { return user?.active !== false; }\n",
    );
    await git("add", ".");
    await git("commit", "--no-gpg-sign", "-m", "Change guard");
    const result = await execute(
      process.execPath,
      [path.resolve("bin/openreview.mjs"), "review", "--agent"],
      {
        cwd: directory,
        env: {
          ...process.env,
          LLM_PROVIDER: "compatible",
          LLM_MODEL: "transport-fixture",
          LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          LLM_ALLOW_LOCAL: "true",
          LLM_API_KEY: "",
        },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout).findings, []);
    assert.ok(contexts.length >= 2);
    assert.ok(
      contexts.every((context) =>
        context.some((file) => file.path === "route.ts"),
      ),
    );
    assert.ok(result.stderr.includes("model.completed"));
    const demo = await execute(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("scripts/demo.ts"),
        "--fixture",
        "cross-file",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          LLM_PROVIDER: "compatible",
          LLM_MODEL: "transport-fixture",
          LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          LLM_ALLOW_LOCAL: "true",
          LLM_API_KEY: "",
        },
      },
    );
    const report = JSON.parse(demo.stdout);
    assert.equal(report.findings, 0);
    assert.ok(
      (await readFile(report.report, "utf8")).includes(
        "No findings passed verification",
      ),
    );
    assert.ok(
      JSON.parse(
        await readFile(report.json, "utf8"),
      ).result.metadata.context.some(
        (item: { path: string }) => item.path === "src/billing.ts",
      ),
    );
    invalidOutput = true;
    await assert.rejects(
      execute(
        process.execPath,
        [
          "--import",
          path.resolve("node_modules/tsx/dist/loader.mjs"),
          path.resolve("scripts/eval.ts"),
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            LLM_PROVIDER: "compatible",
            LLM_MODEL: "transport-fixture",
            LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            LLM_ALLOW_LOCAL: "true",
            LLM_API_KEY: "",
          },
        },
      ),
    );
    const evaluation = JSON.parse(
      await readFile(path.join(directory, "reports/evaluation.json"), "utf8"),
    );
    assert.equal(evaluation.status, "failed");
    assert.equal(evaluation.totals, null);
    assert.equal(evaluation.evaluatedFixtures, 0);
    assert.equal(evaluation.failedFixtures, (await import("../scripts/fixtures")).fixtures.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local bootstrap fills blank secrets, preserves configured secrets, synchronizes embeddings and restricts file permissions", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "openreview-bootstrap-test-"),
  );
  try {
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(
      path.join(directory, ".env.local"),
      'SESSION_SECRET=\nSERVICE_SECRET=configured-secret\nGITHUB_WEBHOOK_SECRET=""\nEMBEDDING_MODEL=embedding-fixture\nLINEAR_CLIENT_ID=linear-fixture\n',
      { mode: 0o644 },
    );
    await execute(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("scripts/bootstrap.ts"),
      ],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    const env = await readFile(path.join(directory, ".env.local"), "utf8");
    assert.match(env, /SESSION_SECRET=[a-f0-9]{64}/);
    assert.match(env, /GITHUB_WEBHOOK_SECRET=[a-f0-9]{64}/);
    assert.ok(env.includes("SERVICE_SECRET=configured-secret"));
    assert.ok(
      (await readFile(path.join(directory, ".env.backend"), "utf8")).includes(
        "EMBEDDING_MODEL=embedding-fixture",
      ),
    );
    assert.ok((await readFile(path.join(directory,".env.backend"),"utf8")).includes("LINEAR_CLIENT_ID=linear-fixture"));
    assert.equal(
      (await stat(path.join(directory, ".env.local"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(path.join(directory, ".env.backend"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
