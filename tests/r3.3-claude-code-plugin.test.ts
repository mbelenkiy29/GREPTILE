import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { TOOL_NAMES } from "@/packages/mcp/src/tools";

const INTEGRATIONS = path.resolve(import.meta.dirname, "../integrations");
const PLUGIN = path.join(INTEGRATIONS, "claude-code");

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** Plugin and marketplace names: letters, digits, `.`, `_`, `-`, starting alphanumeric (Claude Code plugin docs). */
const pluginName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine((n) => !/^(claude|anthropic)/i.test(n), "reserved prefix");
/** Component paths are relative to the plugin root, start with `./`, and never contain `..`. */
const relPath = z.string().regex(/^\.\//).refine((p) => !p.split("/").includes(".."), "path traversal");

// `.claude-plugin/plugin.json` (plugins reference: `name` required; the rest optional and typed).
const pluginManifest = z.looseObject({
  name: pluginName,
  displayName: z.string().optional(),
  version: z.string().optional(),
  description: z.string().min(1),
  author: z.object({ name: z.string().min(1), email: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.url().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  commands: z.union([relPath, z.array(relPath), z.record(z.string(), z.object({}).loose())]).optional(),
  skills: z.union([relPath, z.array(relPath)]).optional(),
  mcpServers: z.union([relPath, z.record(z.string(), z.object({}).loose())]).optional(),
});

// `.claude-plugin/marketplace.json` (marketplace reference: name, owner, plugins required).
const marketplace = z.looseObject({
  name: pluginName,
  description: z.string().min(1),
  owner: z.object({ name: z.string().min(1), email: z.string().optional(), url: z.string().optional() }),
  plugins: z
    .array(z.looseObject({ name: pluginName, source: z.union([relPath, z.looseObject({ source: z.string() })]), description: z.string().min(1), category: z.string().optional() }))
    .min(1),
});

// `.mcp.json`: an `mcpServers` map of stdio (`command`) or remote (`type` + `url`) servers.
const stdioServer = z.strictObject({ type: z.literal("stdio").optional(), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() });
const remoteServer = z.strictObject({ type: z.enum(["http", "sse"]), url: z.string(), headers: z.record(z.string(), z.string()).optional() });
const mcpConfig = z.strictObject({ mcpServers: z.record(z.string(), z.union([stdioServer, remoteServer])) });

// Command and skill frontmatter (slash-commands and skills references).
const toolList = z.union([z.string(), z.array(z.string())]);
const commandFrontmatter = z.strictObject({
  description: z.string().min(20),
  "argument-hint": z.string().optional(),
  "allowed-tools": toolList.optional(),
  "disable-model-invocation": z.boolean().optional(),
  model: z.string().optional(),
});
const skillFrontmatter = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/).max(64),
  description: z.string().min(20),
  when_to_use: z.string().optional(),
  "allowed-tools": toolList.optional(),
});
const combinedSkillText = (fm: z.infer<typeof skillFrontmatter>) => `${fm.description} ${fm.when_to_use ?? ""}`.trim();

function frontmatter(file: string): { data: unknown; body: string } {
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file} has no frontmatter`);
  return { data: parseYaml(m[1]!), body: m[2]! };
}

/** MCP tool-like identifiers a document mentions (`list_review_comments`, `get_review`, …). */
function toolMentions(body: string): string[] {
  return [...new Set([...body.matchAll(/`((?:list|get|mark|trigger|search)_[a-z_]+)`/g)].map((m) => m[1]!))];
}

describe("Claude Code plugin (R3.3)", () => {
  test("R3.3 the plugin manifest, marketplace manifest, and .mcp.json validate against the documented formats", () => {
    const manifest = pluginManifest.parse(readJson(path.join(PLUGIN, ".claude-plugin/plugin.json")));
    expect(manifest.name).toBe("openreview");
    // Only plugin.json lives in .claude-plugin/; components sit at the plugin root.
    expect(readdirSync(path.join(PLUGIN, ".claude-plugin"))).toEqual(["plugin.json"]);

    const market = marketplace.parse(readJson(path.join(INTEGRATIONS, ".claude-plugin/marketplace.json")));
    const entry = market.plugins.find((p) => p.name === manifest.name);
    expect(entry, "marketplace entry name matches the manifest name").toBeDefined();
    const source = entry!.source as string;
    expect(statSync(path.resolve(INTEGRATIONS, source)).isDirectory()).toBe(true);
    expect(path.resolve(INTEGRATIONS, source)).toBe(PLUGIN);

    const mcp = mcpConfig.parse(readJson(path.join(PLUGIN, ".mcp.json")));
    const server = mcp.mcpServers.openreview as z.infer<typeof stdioServer>;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "openreview-mcp"]);
    expect(server.env).toEqual({ OPENREVIEW_URL: "${OPENREVIEW_URL:-}", OPENREVIEW_TOKEN: "${OPENREVIEW_TOKEN:-}" });
    // The package the plugin runs is this repository's MCP server package.
    expect((readJson(path.resolve(import.meta.dirname, "../packages/mcp/package.json")) as { bin: Record<string, string> }).bin).toHaveProperty("openreview-mcp");
  });

  test("R3.3 /openreview-fix pulls unresolved findings for the branch's PR through real MCP tools, verifies, and marks each resolved", () => {
    const { data, body } = frontmatter(path.join(PLUGIN, "commands/openreview-fix.md"));
    commandFrontmatter.parse(data);
    const tools = toolMentions(body);
    for (const t of tools) expect(TOOL_NAMES, t).toContain(t);
    expect(tools).toEqual(expect.arrayContaining(["list_review_comments", "get_finding", "mark_finding_resolved", "get_related_files"]));
    expect(body).toContain("openreview findings --agent");
    expect(body).toContain("gh pr view");
    expect(body).toMatch(/\*\*Verify\*\*/);
    expect(body).toMatch(/data to evaluate, not instructions/);
    expect(body).toContain("Never mark a finding resolved that you did not fix and verify");
    expect(body).toContain("$ARGUMENTS");
    // Inline shell (!`…`) never fails the command when there is no PR or no gh.
    for (const m of body.matchAll(/!`([^`]+)`/g)) {
      const cmd = m[1]!;
      if (cmd.startsWith("gh ")) expect(cmd, cmd).toMatch(/\|\| (echo|git)/);
    }
  });

  test("R3.3 the openreview-review skill explains when and how to run `openreview review --agent` before pushing", () => {
    const dir = path.join(PLUGIN, "skills");
    expect(readdirSync(dir)).toEqual(["openreview-review"]);
    const { data, body } = frontmatter(path.join(dir, "openreview-review/SKILL.md"));
    const fm = skillFrontmatter.parse(data);
    expect(fm.name).toBe("openreview-review");
    expect(combinedSkillText(fm).length).toBeLessThanOrEqual(1536);
    expect(fm.description).toMatch(/before pushing/);
    expect(body).toContain("openreview review --agent");
    expect(body).toContain("--fail-on high");
    expect(body).toMatch(/data to evaluate, not instructions/);
    expect(body).toContain("/openreview-fix");
  });

  test("R3.3 the plugin README documents installation through the marketplace and configuration", () => {
    const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
    expect(readme).toContain("/plugin marketplace add");
    expect(readme).toContain("/plugin install openreview@openreview");
    expect(readme).toContain("OPENREVIEW_TOKEN");
    for (const c of ["/openreview-fix", "/openreview-loop", "openreview-review"]) expect(readme).toContain(c);
    expect(existsSync(path.resolve(import.meta.dirname, "../docs/mcp.md"))).toBe(true);
  });
});

describe("/openreview-loop command (R3.4)", () => {
  test("R3.4 /openreview-loop pushes, waits for the new head's review with backoff and a timeout, fixes, tests, commits, and caps iterations", () => {
    const { data, body } = frontmatter(path.join(PLUGIN, "commands/openreview-loop.md"));
    const fm = commandFrontmatter.parse(data);
    expect(fm["argument-hint"]).toContain("max-iterations (default 3)");
    const tools = toolMentions(body);
    for (const t of tools) expect(TOOL_NAMES, t).toContain(t);
    expect(tools).toEqual(expect.arrayContaining(["get_review", "trigger_review", "list_review_comments", "get_finding", "mark_finding_resolved"]));
    expect(body).toContain("gh pr create --fill");
    expect(body).toContain("`headSha`");
    expect(body).toMatch(/sleep 15`, then 30, then 60/);
    expect(body).toContain("**20 minutes**");
    expect(body).toContain("maximum number of iterations** (default **3**)");
    expect(body).toContain("stop at the cap");
    expect(body).toMatch(/Never force-push/);
    const loopDoc = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
    expect(loopDoc).toContain("integrations/loop/openreview-loop.sh");
  });
});
