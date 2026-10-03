#!/usr/bin/env node
/** `openreview-mcp`: OpenReview's MCP server over stdio (configure with OPENREVIEW_URL and OPENREVIEW_TOKEN). */
import { ConfigError } from "./rest.js";
import { PACKAGE_VERSION, runStdioServer } from "./stdio.js";

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  process.stdout.write(`${PACKAGE_VERSION}\n`);
} else if (arg === "--help" || arg === "-h") {
  process.stdout.write(
    [
      "openreview-mcp — OpenReview's MCP server (stdio)",
      "",
      "Environment:",
      "  OPENREVIEW_URL    your OpenReview server, e.g. https://review.example.com",
      "  OPENREVIEW_TOKEN  an API key (or_live_…) from Settings → API keys",
      "Without them, the `openreview` CLI's ~/.config/openreview/config.json is used.",
      "",
      "Claude Code:  claude mcp add openreview -e OPENREVIEW_URL=… -e OPENREVIEW_TOKEN=… -- npx -y openreview-mcp",
      "",
    ].join("\n"),
  );
} else {
  runStdioServer({ env: process.env }).catch((err: unknown) => {
    process.stderr.write(`openreview-mcp: ${err instanceof ConfigError || err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
