import type { Metadata } from "next";
import {cookies} from "next/headers";
import {ThemeProvider} from "./theme";
import "./globals.css";
export const metadata: Metadata = {
  title: "OpenReview",
  description: "Self-hosted, repository-aware pull request reviews.",
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
