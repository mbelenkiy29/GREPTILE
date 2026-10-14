"use client";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Shows the one-shot message a server action left in the `openreview_toast` cookie, then clears it.
export function Toaster() {
  const pathname = usePathname(), params = useSearchParams();
  const [toast, setToast] = useState<{ text: string; tone: string } | null>(null);
  useEffect(() => {
    const raw = document.cookie.split("; ").find((c) => c.startsWith("openreview_toast="))?.slice("openreview_toast=".length);
    if (!raw) return;
    document.cookie = "openreview_toast=; Max-Age=0; Path=/; SameSite=Lax";
    try { const value = JSON.parse(decodeURIComponent(raw)) as { text?: unknown; tone?: unknown }; if (typeof value.text === "string") setToast({ text: value.text.slice(0, 200), tone: value.tone === "error" ? "error" : "success" }); } catch { /* ignore malformed */ }
  }, [pathname, params]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite"><span>{toast.text}</span><button type="button" className="small" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div>;
}
