/**
 * Security headers on every response, pages and API routes alike (R6.20), applied by `next.config.ts`.
 *
 * The Content-Security-Policy is a static policy that fits how the app is built: everything is served from the app's
 * own origin (no CDNs, no web fonts, no third-party scripts), Next.js's inline bootstrap scripts and React's inline
 * styles need 'unsafe-inline' (a nonce-based policy would force every page to render dynamically), and avatars are the
 * only remote images. Framing is refused outright (clickjacking). Form submissions may lead to any https origin
 * because SSO sign-in posts to the app, which then redirects to the organization's identity provider.
 *
 * HSTS is always sent in production builds: browsers ignore it on plain-http responses (RFC 6797 §8.1), so it only
 * takes effect when the app is actually served over https.
 */

export interface HeaderOptions {
  /** `next dev` needs eval for React Refresh and http form targets for local identity providers. */
  development: boolean;
}

export function contentSecurityPolicy(opts: HeaderOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(opts.development ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(opts.development ? ["ws:", "wss:"] : [])],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", "https:", ...(opts.development ? ["http:"] : [])],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

export function securityHeaders(opts: HeaderOptions): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(opts) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    ...(opts.development ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
  ];
}
