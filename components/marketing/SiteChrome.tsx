import Link from "next/link";
import { Brand } from "@/components/shell/Brand";
import { Icon } from "@/components/ui/icons";
import { APP_VERSION } from "@/lib/version";

/**
 * Same-origin link to the running version's source: `/source` redirects to SOURCE_CODE_URL at request time
 * (AGPL-3.0 §13), so statically generated pages link to the operator's configured source too.
 */
export const SOURCE_HREF = "/source";

/** "Source code on GitHub" when the source is hosted there, else "Source code". */
export function sourceLabel(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname === "github.com" ? "Source code on GitHub" : "Source code";
  } catch {
    return "Source code";
  }
}

/** Header of the public site (R5.1): brand, primary navigation, and the sign-in / get-started actions. */
export function SiteHeader({ sourceUrl, current }: { sourceUrl: string; current?: "docs" | "pricing" }) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Brand href="/" />
        <nav className="site-nav" aria-label="Main">
          <Link href="/docs" aria-current={current === "docs" ? "page" : undefined}>
            Docs
          </Link>
          <Link href="/pricing" aria-current={current === "pricing" ? "page" : undefined}>
            Pricing
          </Link>
          <a href={sourceUrl} className="site-nav-source" rel="noreferrer">
            <Icon name="github" size={16} />
            <span>Source</span>
          </a>
        </nav>
        <div className="site-header-actions">
          <Link href="/sign-in" className="site-signin">
            Sign in
          </Link>
          <Link href="/sign-in" className="button button-primary button-sm">
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

/**
 * Footer of the public site: product, docs, and project links, and the source code link that AGPL-3.0 §13 asks a
 * network service to offer its users.
 */
export function SiteFooter({ sourceUrl }: { sourceUrl: string }) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Brand href="/" size={22} />
          <p className="dim">Open-source AI code review with full-codebase context. Free software under the GNU AGPL-3.0.</p>
        </div>
        <nav aria-label="Product" className="site-footer-col">
          <h2 className="eyebrow">Product</h2>
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
        <nav aria-label="Documentation" className="site-footer-col">
          <h2 className="eyebrow">Docs</h2>
          <Link href="/docs/quickstart">Quickstart</Link>
          <Link href="/docs/self-hosting">Self-hosting</Link>
          <Link href="/docs/configuration">openreview.json</Link>
          <Link href="/docs/api">REST API</Link>
        </nav>
        <nav aria-label="Project" className="site-footer-col">
          <h2 className="eyebrow">Project</h2>
          <a href={sourceUrl} rel="noreferrer" data-source-link="">
            {sourceLabel(sourceUrl)}
          </a>
          <Link href="/docs/github-app">GitHub App</Link>
          <Link href="/docs/security">Security</Link>
        </nav>
      </div>
      <div className="site-footer-legal">
        <span>
          OpenReview v{APP_VERSION} · <a href={sourceUrl} rel="noreferrer">Source</a> · AGPL-3.0
        </span>
      </div>
    </footer>
  );
}
