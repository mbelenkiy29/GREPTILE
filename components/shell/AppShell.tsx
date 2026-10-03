"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ShellFrame } from "./ShellFrame";

/** Client wrapper of {@link ShellFrame}: tracks the current path (active nav) and the mobile menu. */
export function AppShell({ account, tools, footer, children }: { account: ReactNode; tools?: ReactNode; footer: ReactNode; children: ReactNode }) {
  const pathname = usePathname() ?? "/dashboard";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <ShellFrame
      pathname={pathname}
      menuOpen={open}
      onToggleMenu={() => setOpen((o) => !o)}
      onNavigate={() => setOpen(false)}
      account={account}
      tools={tools}
      footer={footer}
    >
      {children}
    </ShellFrame>
  );
}
