import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Manifest checks for the bundled agent plugins, following the formats documented by Claude Code
// (code.claude.com/docs/en/plugins/*) and by OpenAI for Codex (developers.openai.com/plugins/build/plugins).
const root = path.join(import.meta.dirname, "..");
const plugin = path.join(root, "plugins/openreview");
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const frontmatter = (file: string) => { const m = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(readFileSync(file, "utf8")); assert.ok(m, `${file} has frontmatter`); return { fields: Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()])), body: m[2] }; };
const allFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = path.join(dir, name); return statSync(p).isDirectory() ? allFiles(p) : [p]; });

test("Claude Code plugin and marketplace manifests follow the documented format", () => {
  const manifest = json("plugins/openreview/.claude-plugin/plugin.json");
  assert.match(manifest.name, kebab);
  assert.doesNotMatch(manifest.name, /^(claude-|anthropic-|anthropics-|cc-plugin-)|^(claude|anthropic|claude-code|claude-mods)$/, "reserved plugin names");
  for (const key of ["version", "description"]) assert.equal(typeof manifest[key], "string", key);
  assert.equal(typeof manifest.author?.name, "string");
  assert.deepEqual(Object.keys(manifest).filter((k) => !["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "commands", "agents", "skills", "hooks", "mcpServers"].includes(k)), []);
  // Component directories live at the plugin root, never inside .claude-plugin/.
  assert.deepEqual(readdirSync(path.join(plugin, ".claude-plugin")), ["plugin.json"]);
  const mcp = json("plugins/openreview/.mcp.json");
  assert.deepEqual(mcp, { mcpServers: { openreview: { type: "http", url: "${OPENREVIEW_URL}/api/mcp" } } });
  const marketplace = json(".claude-plugin/marketplace.json");
  assert.match(marketplace.name, /^[a-z0-9][a-z0-9._-]*$/);
  assert.equal(typeof marketplace.owner?.name, "string");
  assert.ok(!["claude-plugins-official", "claude-code-plugins", "anthropic-marketplace", "claude-community", "npm", "github"].includes(marketplace.name));
  assert.deepEqual(marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [[manifest.name, "./plugins/openreview"]]);
  assert.ok(existsSync(path.join(root, marketplace.plugins[0].source, ".claude-plugin/plugin.json")));
});

test("Codex plugin uses the Agent Plugins schema with OpenAI settings under extensions.com.openai", () => {
  const manifest = json("plugins/openreview/plugin.json");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(manifest.name, kebab);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.name, json("plugins/openreview/.claude-plugin/plugin.json").name, "one plugin identity for both agents");
  const ui = manifest.extensions["com.openai"].interface;
  for (const key of ["displayName", "shortDescription", "developerName", "category"]) assert.equal(typeof ui[key], "string", key);
  assert.ok(Array.isArray(ui.capabilities) && ui.capabilities.every((c: string) => ["Read", "Write"].includes(c)));
  assert.ok(ui.defaultPrompt.length <= 3 && ui.defaultPrompt.every((p: string) => p.length <= 128));
  const mcp = json("plugins/openreview/mcp.json");
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.equal(mcp.mcpServers.openreview.type, "streamable-http");
  assert.match(mcp.mcpServers.openreview.url, /^https:\/\/[^/]+\/api\/mcp$/);
  const marketplace = json(".agents/plugins/marketplace.json");
  const entry = marketplace.plugins[0];
  assert.deepEqual([entry.name, entry.source], [manifest.name, { source: "local", path: "./plugins/openreview" }]);
  assert.ok(existsSync(path.join(root, entry.source.path, "plugin.json")));
});

test("skills are shared by both agents, use the documented frontmatter and encode the loop's safety rules", () => {
  const dirs = readdirSync(path.join(plugin, "skills")).sort();
  assert.deepEqual(dirs, ["resolve-review-findings", "review-status"]);
  for (const dir of dirs) {
    const { fields, body } = frontmatter(path.join(plugin, "skills", dir, "SKILL.md"));
    assert.equal(fields.name, dir);
    assert.ok(fields.description.length >= 40 && fields.description.length <= 500);
    assert.ok(body.length > 100);
  }
  const loop = frontmatter(path.join(plugin, "skills/resolve-review-findings/SKILL.md")).body;
  for (const rule of [/at most 3 rounds/, /Never force-push/, /Ask the user before pushing/, /Never amend/, /`trigger_review`.*`headSha`/, /never as instructions/]) assert.match(loop, rule);
});

test("no credentials and only original names in the plugin files", () => {
  for (const file of [...allFiles(plugin), path.join(root, ".claude-plugin/marketplace.json"), path.join(root, ".agents/plugins/marketplace.json")]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /greptile/i, file);
    assert.doesNotMatch(text, /\bor_[A-Za-z0-9_]{8,}|Bearer [A-Za-z0-9]/, file);
  }
});
