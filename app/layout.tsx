import type { Metadata } from "next";
import {cookies} from "next/headers";
import {ThemeProvider} from "./theme";
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
      <body><ThemeProvider initial={theme}>{children}</ThemeProvider></body>
    </html>
  );
}
