import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone', outputFileTracingRoot: process.cwd(), poweredByHeader: false,
  // OAuth discovery documents for the remote MCP endpoint (RFC 9728 and RFC 8414 well-known paths).
  async rewrites() {
    return [
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/metadata/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/metadata/protected-resource' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata/authorization-server' },
    ];
  },
};
export default config;
