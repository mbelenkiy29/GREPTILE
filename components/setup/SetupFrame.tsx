import type { ReactNode } from "react";
import { Brand } from "@/components/shell/Brand";

/** The card layout of the GitHub App setup pages (R6.25). */
export function SetupFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card stack-md">
        <Brand href="/" />
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
