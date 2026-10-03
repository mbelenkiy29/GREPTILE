import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseDocument, type Tags } from "yaml";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Repository documentation this suite keeps honest (R6.25). */
const DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/ARCHITECTURE.md",
  "docs/DATABASE.md",
  "docs/configuration.md",
  "docs/self-hosting.md",
  "docs/github-app.md",
  "docs/models.md",
  "docs/cli.md",
  "docs/troubleshooting.md",
  "docs/mcp.md",
  "docs/gitlab.md",
  "docs/bitbucket.md",
  "packages/cli/README.md",
];

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    out.add(
      m[1]!
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-"),
    );
  }
  return out;
}

/** Docker Compose's YAML tags (`!override`, `!reset`) parse as plain values. */
const composeTags: Tags = ["!override", "!reset"].flatMap((tag) => [
  { tag, collection: "seq" as const, resolve: (v: unknown) => v },
  { tag, collection: "map" as const, resolve: (v: unknown) => v },
  { tag, resolve: (v: string) => v },
]);

function parseYaml(rel: string): Record<string, unknown> {
  const doc = parseDocument(read(rel), { customTags: composeTags });
  expect(doc.errors, rel).toEqual([]);
  return doc.toJS() as Record<string, unknown>;
}

type Service = { build?: { target?: string }; healthcheck?: unknown; volumes?: string[]; logging?: unknown; restart?: string; ports?: string[]; environment?: Record<string, string> };

describe("self-hosting and open-source docs (R6.25)", () => {
  test("R6.25 the README has every required section and every repository doc exists", () => {
    const readme = read("README.md");
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    for (const h of [
      "Features",
      "Architecture",
      "Quick start (Docker Compose)",
      "Local development",
      "GitHub App",
      "Configuration",
      "Models",
      "CLI",
      "MCP and coding agents",
      "GitLab and Bitbucket",
      "Troubleshooting",
      "Contributing",
      "Security",
      "License",
    ]) {
      expect(headings, h).toContain(h);
    }
    expect(readme).toMatch(/```mermaid\n/);
    expect(readme).toContain("AGPL-3.0-only");
    expect(readme).toContain("SOURCE_CODE_URL");
    expect(read("docs/ARCHITECTURE.md")).toMatch(/```mermaid\nsequenceDiagram/);
    for (const f of [...DOCS, "LICENSE", ".github/pull_request_template.md", "github-app-manifest.json", "deploy/Caddyfile", "deploy/backup.sh"]) {
      expect(existsSync(path.join(ROOT, f)), f).toBe(true);
    }
    for (const t of readdirSync(path.join(ROOT, ".github/ISSUE_TEMPLATE"))) parseYaml(`.github/ISSUE_TEMPLATE/${t}`);
    expect(readdirSync(path.join(ROOT, ".github/ISSUE_TEMPLATE")).sort()).toEqual(["bug_report.yml", "config.yml", "feature_request.yml"]);
    // H1: an original brand only.
    for (const f of DOCS) expect(read(f), f).not.toMatch(/greptile/i);
  });

  test("R6.25 relative links in the docs resolve to existing files and headings", () => {
    const problems: string[] = [];
    for (const doc of DOCS) {
      const text = read(doc).replace(/```[\s\S]*?```/g, "");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [file, anchor] = target.split("#") as [string, string | undefined];
        const resolved = file ? path.resolve(path.dirname(path.join(ROOT, doc)), file) : path.join(ROOT, doc);
        if (!existsSync(resolved)) {
          problems.push(`${doc}: ${target} (missing file)`);
          continue;
        }
        if (anchor && resolved.endsWith(".md") && !anchorsOf(readFileSync(resolved, "utf8")).has(anchor)) {
          problems.push(`${doc}: ${target} (missing heading)`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("R6.25 every .env.example variable is documented in docs/configuration.md and validated in lib/env.ts, and vice versa", () => {
    const example = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    const configuration = read("docs/configuration.md");
    const envTs = read("lib/env.ts");
    const validated = new Set([...envTs.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));
    // Read straight from process.env (outside lib/env.ts) by a specific file, or by Next.js itself.
    const direct: Record<string, string> = {
      ENCRYPTION_KEY: "lib/crypto.ts",
      LOG_LEVEL: "lib/log.ts",
      RUN_MIGRATIONS: "instrumentation.ts",
    };
    // Read by Docker Compose / the deploy files, never by the application.
    const composeOnly = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "APP_PORT", "EXTRA_CA_CERT", "OPENREVIEW_DOMAIN"];
    const compose = ["docker-compose.yml", "deploy/docker-compose.prod.yml"].map(read).join("\n");

    expect(new Set(example).size).toBe(example.length);
    for (const v of example) {
      expect(configuration, `${v} in docs/configuration.md`).toContain(`\`${v}\``);
      if (validated.has(v)) continue;
      if (direct[v]) {
        expect(read(direct[v]), `${v} read in ${direct[v]}`).toContain(`process.env.${v}`);
      } else if (v === "NEXT_TELEMETRY_DISABLED") {
        expect(read("Dockerfile")).toContain("NEXT_TELEMETRY_DISABLED=1");
      } else {
        expect(composeOnly, `${v} is neither validated in lib/env.ts nor a known deployment variable`).toContain(v);
        expect(compose, `${v} used by a compose file`).toContain(`\${${v}`);
      }
    }
    for (const v of validated) expect(example, `${v} (lib/env.ts) in .env.example`).toContain(v);
  });

  test("R6.25 every table in the schema is documented in docs/DATABASE.md", () => {
    const schema = read("lib/db/schema.ts");
    const tables = [...schema.matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThan(50);
    const database = read("docs/DATABASE.md");
    const rows = new Set([...database.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!));
    expect(tables.filter((t) => !rows.has(t))).toEqual([]);
    // No stale rows for tables that no longer exist.
    expect([...rows].filter((r) => !tables.includes(r))).toEqual([]);
  });

  test("R6.25 the compose files parse, build existing Dockerfile targets, and have health checks; the production override fronts the app with Caddy", () => {
    const dockerfile = read("Dockerfile");
    const targets = new Set([...dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((m) => m[1]!));
    expect(dockerfile).toMatch(/HEALTHCHECK [\s\S]*\/api\/health/);
    // Every workspace package's manifest and installed dependencies reach the image.
    for (const pkg of readdirSync(path.join(ROOT, "packages"))) {
      expect(dockerfile).toContain(`COPY packages/${pkg}/package.json packages/${pkg}/`);
      expect(dockerfile).toContain(`COPY --from=deps /app/packages/${pkg}/node_modules ./packages/${pkg}/node_modules`);
    }

    const base = parseYaml("docker-compose.yml") as { services: Record<string, Service> };
    for (const [name, svc] of Object.entries(base.services)) {
      if (svc.build?.target) expect(targets, `${name} builds ${svc.build.target}`).toContain(svc.build.target);
      expect(svc.healthcheck, `${name} healthcheck`).toBeDefined();
      for (const v of svc.volumes ?? []) {
        if (v.startsWith("./")) expect(existsSync(path.join(ROOT, v.split(":")[0]!)), v).toBe(true);
      }
    }
    expect(base.services.app!.build!.target).toBe("runner");
    expect(base.services.worker!.build!.target).toBe("worker");
    expect(base.services.worker!.healthcheck).toMatchObject({ test: ["CMD", "node_modules/.bin/tsx", "worker/healthcheck.ts"] });
    for (const name of ["app", "worker"]) expect(base.services[name]!.environment!.NODE_ENV).toBe("production");

    const offline = parseYaml("docker-compose.offline.yml") as { services: Record<string, Service> };
    for (const name of Object.keys(offline.services)) expect(base.services, name).toHaveProperty(name);

    const prod = parseYaml("deploy/docker-compose.prod.yml") as { services: Record<string, Service>; volumes: Record<string, unknown> };
    for (const name of Object.keys(base.services)) {
      expect(prod.services[name], name).toMatchObject({ restart: "unless-stopped", logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "5" } } });
    }
    const caddy = prod.services.caddy!;
    expect(caddy.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    expect(caddy.volumes).toContain("./deploy/Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(prod.services.app!.ports).toEqual(["127.0.0.1:${APP_PORT:-3000}:3000"]);
    expect(read("deploy/docker-compose.prod.yml")).toMatch(/ports: !override\n/);
    expect(Object.keys(prod.volumes).sort()).toEqual(["caddyconfig", "caddydata"]);
    const caddyfile = read("deploy/Caddyfile");
    expect(caddyfile).toMatch(/^\{\$OPENREVIEW_DOMAIN\} \{\n\s+encode zstd gzip\n\s+reverse_proxy app:3000\n\}/m);
    // Backups never end up in the image or the repository.
    expect(read(".dockerignore").split("\n")).toContain("backups");
    expect(read(".gitignore")).toContain("/backups/");
  });

  test("R6.25 the documented package scripts exist", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; engines: { node: string } };
    const docs = read("README.md") + read("CONTRIBUTING.md");
    for (const script of ["dev", "build", "test", "typecheck", "lint", "verify:parity", "db:generate", "db:migrate", "worker", "cli:build", "mcp:build", "deps:audit"]) {
      expect(pkg.scripts[script], script).toBeDefined();
      expect(docs, `pnpm ${script} documented`).toContain(`pnpm ${script}`);
    }
    // `pnpm worker` and `pnpm db:migrate` read .env like `pnpm dev` does (Node 22.9+).
    expect(pkg.scripts.worker).toBe("tsx --env-file-if-exists=.env worker/index.ts");
    expect(pkg.scripts["db:migrate"]).toBe("tsx --env-file-if-exists=.env scripts/migrate.ts");
    expect(pkg.engines.node).toBe(">=22.9");
  });

  test("R6.25 deploy/backup.sh writes a pg_dump from the postgres service and prunes old dumps", () => {
    const work = mkdtempSync(path.join(tmpdir(), "or-backup-"));
    try {
      const bin = path.join(work, "bin");
      const out = path.join(work, "out");
      execFileSync("mkdir", ["-p", bin, out]);
      const fakeDocker = path.join(bin, "docker");
      // Records its arguments and prints a fake custom-format dump (or fails when FAIL is set).
      writeFileSync(
        fakeDocker,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(work, "calls.log")}"\nif [ -n "$FAIL" ]; then exit 3; fi\nprintf 'PGDMP fake dump'\n`,
      );
      chmodSync(fakeDocker, 0o755);
      const old = path.join(out, "openreview-20200101T000000Z.dump");
      writeFileSync(old, "old");
      const longAgo = new Date(Date.now() - 30 * 86_400_000);
      utimesSync(old, longAgo, longAgo);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

      const stdout = execFileSync("sh", [path.join(ROOT, "deploy/backup.sh"), out, "7"], { env, encoding: "utf8" });
      const dumps = readdirSync(out);
      expect(dumps).toHaveLength(1);
      expect(dumps[0]).toMatch(/^openreview-\d{8}T\d{6}Z\.dump$/);
      expect(readFileSync(path.join(out, dumps[0]!), "utf8")).toBe("PGDMP fake dump");
      expect((statSync(path.join(out, dumps[0]!)).mode & 0o077) === 0).toBe(true);
      expect(stdout).toContain("backup written:");
      const call = readFileSync(path.join(work, "calls.log"), "utf8");
      expect(call).toContain("compose exec -T postgres sh -c pg_dump -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" --format=custom --no-owner");

      // A failing pg_dump leaves no partial file and exits non-zero.
      expect(() => execFileSync("sh", [path.join(ROOT, "deploy/backup.sh"), out, "7"], { env: { ...env, FAIL: "1" }, stdio: "pipe" })).toThrow();
      expect(readdirSync(out).filter((f) => f.endsWith(".partial"))).toEqual([]);
      expect(() => execFileSync("sh", [path.join(ROOT, "deploy/backup.sh"), out, "x"], { env, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
