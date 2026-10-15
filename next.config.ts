import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
import { posthogHosts, posthogProxyPath, posthogToken, sentryDsn, sentryTunnelPath } from './src/telemetry';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  // PostHog through this site's own origin, only when analytics is configured (src/telemetry.ts).
  ...(posthogToken ? {
    skipTrailingSlashRedirect: true,
    async rewrites() {
      const hosts = posthogHosts();
      return [
        { source: `${posthogProxyPath}/static/:path*`, destination: `${hosts.assets}/static/:path*` },
        { source: `${posthogProxyPath}/array/:path*`, destination: `${hosts.assets}/array/:path*` },
        { source: `${posthogProxyPath}/:path*`, destination: `${hosts.api}/:path*` },
      ];
    },
  } : {}),
};

// Sentry wraps the build only when error tracking is configured. Source maps upload when
// SENTRY_AUTH_TOKEN (with SENTRY_ORG and SENTRY_PROJECT) is present at build time.
export default sentryDsn ? withSentryConfig(config, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: sentryTunnelPath,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  silent: !process.env.CI,
  telemetry: false,
}) : config;
