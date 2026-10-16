import type { Metadata } from "next";
import {cookies} from "next/headers";
import {ThemeProvider} from "./theme";
import {ConsentBanner} from "./consent";
// Fonts are bundled from npm so builds never fetch them: Inter for UI, JetBrains Mono for code
// and metadata, EB Garamond for editorial subheads.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/500.css";
import "./globals.css";
const description = "Repository-aware pull request reviews with exact-quote evidence. Self-host it or use the cloud.";
export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: { default: "OpenReview: repository-aware pull request reviews", template: "%s · OpenReview" },
  description,
  openGraph: { type: "website", siteName: "OpenReview", title: "OpenReview", description },
  twitter: { card: "summary_large_image", title: "OpenReview", description },
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const preference=(await cookies()).get("openreview_theme")?.value;
  const theme=preference==="light"||preference==="dark"?preference:"system";
  return (
    <html lang="en" data-theme={theme}>
      <body><ThemeProvider initial={theme}>{children}<ConsentBanner /></ThemeProvider></body>
    </html>
  );
}
