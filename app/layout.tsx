import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { siteOrigin } from "@/lib/site";
import { parseTheme, THEME_COOKIE, themeAttribute } from "@/lib/ui/theme";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: { default: "OpenReview", template: "%s · OpenReview" },
  description: "AI pull request reviews with full-codebase context.",
  applicationName: "OpenReview",
  openGraph: { siteName: "OpenReview", type: "website", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1014" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    // The marketing layout may set data-theme from the cookie on statically generated pages before hydration.
    <html lang="en" data-theme={themeAttribute(theme)} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
