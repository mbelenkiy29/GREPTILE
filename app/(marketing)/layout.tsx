import type { ReactNode } from "react";
import { SiteFooter, SiteHeader, SOURCE_HREF } from "@/components/marketing/SiteChrome";
import { THEME_COOKIE } from "@/lib/ui/theme";


/**
 * Statically generated pages (the docs) are rendered without the request's cookies, so a theme the visitor pinned
 * in the dashboard is applied here before first paint. Pages rendered per request already carry it on <html>.
 */
const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)/);if(m)document.documentElement.setAttribute("data-theme",m[1]);}catch(e){}})();`;

/** Public site layout (R5.1–R5.3): marketing header and footer, separate from the dashboard shell. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SiteHeader sourceUrl={SOURCE_HREF} />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter sourceUrl={SOURCE_HREF} />
    </div>
  );
}
