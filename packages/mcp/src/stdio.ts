/** The local stdio MCP server: OpenReview's tools over stdin/stdout, proxied to a server's REST API. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig, restApi, type RestApiOptions } from "./rest.js";
import { createOpenReviewMcpServer } from "./tools.js";

export const PACKAGE_VERSION = "0.1.0";

export interface StdioOptions {
  env: Record<string, string | undefined>;
  fetch?: RestApiOptions["fetch"];
  /** Diagnostics go to stderr: stdout carries the protocol. */
  log?: (line: string) => void;
}

/** Resolves the configuration, then serves MCP on stdio until the client disconnects. */
export async function runStdioServer(opts: StdioOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const config = await resolveConfig(opts.env);
  const api = restApi({ config, ...(opts.fetch ? { fetch: opts.fetch } : {}), userAgent: `openreview-mcp/${PACKAGE_VERSION}` });
  const server = createOpenReviewMcpServer(api, { name: "openreview", version: PACKAGE_VERSION });
  await server.connect(new StdioServerTransport());
  log(`openreview-mcp ${PACKAGE_VERSION}: serving ${config.url} (settings from ${config.source})`);
}
