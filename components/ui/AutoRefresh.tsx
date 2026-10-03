"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the current page's server components every `intervalMs` while `active` (e.g. an index job or review
 * run is in progress), so progress stays live without a client data layer. Pauses while the tab is hidden.
 */
export function AutoRefresh({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, Math.max(2000, intervalMs));
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
