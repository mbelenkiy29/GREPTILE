import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("MCP initializes over stdio and exposes the documented agent tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp.ts"],
    env: {
      PATH: process.env.PATH ?? "",
      OPENREVIEW_URL: "http://localhost:3000",
      OPENREVIEW_API_KEY: "or_test_key_for_protocol_only",
    },
  });
  const client = new Client({ name: "openreview-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      [
        "get_review",
        "get_findings",
        "get_finding",
        "get_repository_context",
        "search_codebase",
        "get_related_files",
        "get_custom_rules",
        "mark_finding_resolved",
        "list_repositories",
        "ask_codebase",
        "search_code",
      ].sort(),
    );
    // Network failures surface as tool errors, never crashes.
    const failed = await client.callTool({ name: "list_repositories", arguments: {} });
    assert.equal(failed.isError, true);
  } finally {
    await client.close();
  }
});
