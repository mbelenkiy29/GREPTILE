import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
loadEnvFile(".env.local");
const deploymentUrl = "http://127.0.0.1:3212";
const adminKey = execFileSync(
  "docker",
  ["exec", "openreview-backend-verification", "./generate_admin_key.sh"],
  { encoding: "utf8" },
).trim();
const directory = await mkdtemp(
  path.join(tmpdir(), "openreview-selfhost-verification-"),
);
const deploymentFile = path.join(directory, "deployment.env"),
  secretsFile = path.join(directory, "secrets.env");
await writeFile(
  deploymentFile,
  `CONVEX_SELF_HOSTED_URL=${deploymentUrl}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`,
  { mode: 0o600 },
);
await writeFile(
  secretsFile,
  `SESSION_SECRET=${process.env.SESSION_SECRET}\nSERVICE_SECRET=${process.env.SERVICE_SECRET}\nGITHUB_WEBHOOK_SECRET=${process.env.GITHUB_WEBHOOK_SECRET}\n`,
  { mode: 0o600 },
);
execFileSync(
  "pnpm",
  ["exec", "convex", "deploy", "--env-file", deploymentFile, "--yes"],
  { stdio: "inherit" },
);
execFileSync(
  "pnpm",
  [
    "exec",
    "convex",
    "env",
    "set",
    "--env-file",
    deploymentFile,
    "--from-file",
    secretsFile,
  ],
  { stdio: "inherit" },
);
const backend = new ConvexHttpClient(deploymentUrl);
await backend.mutation(api.users.login, {
  secret: process.env.SERVICE_SECRET!,
  githubId: -300,
  login: "selfhost-verification-fixture",
  avatar: "",
});
const health = await fetch("http://127.0.0.1:3213/health");
if (!health.ok) throw new Error("Docker backend HTTP health check failed");
console.log(
  "Self-hosted Docker backend passed schema/function deployment, environment synchronization, authenticated persistence and HTTP health checks. Admin credentials were not printed.",
);
