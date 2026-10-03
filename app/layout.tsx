import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { parseTheme, THEME_COOKIE, themeAttribute } from "@/lib/ui/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OpenReview", template: "%s · OpenReview" },
  description: "AI pull request reviews with full-codebase context.",
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
    <html lang="en" data-theme={themeAttribute(theme)}>
      <body>{children}</body>
    </html>
  );
}
