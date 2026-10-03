"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toastFor } from "@/lib/ui/toast";
import { Icon } from "./icons";

function removeToast(router: ReturnType<typeof useRouter>, pathname: string, params: URLSearchParams | ReturnType<typeof useSearchParams>) {
  const next = new URLSearchParams(params.toString());
  next.delete("toast");
  const qs = next.toString();
  router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
}

const ICON = { success: "check", info: "info", warning: "alert", error: "alert" } as const;

/**
 * Shows the result of a server action. Actions redirect back with `?toast=<code>`; only codes from the fixed table in
 * `lib/ui/toast` render (never text from the URL). Dismissing — or 6 seconds passing — removes the parameter.
 */
export function Toaster() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const toast = toastFor(params.get("toast"));

  const code = toast?.code;
  const dismiss = () => removeToast(router, pathname, params);

  useEffect(() => {
    if (!code) return;
    const t = setTimeout(() => removeToast(router, pathname, params), 6000);
    return () => clearTimeout(t);
  }, [code, router, pathname, params]);

  return (
    <div className="toast-region" aria-live={toast?.tone === "error" ? "assertive" : "polite"} role="status">
      {toast && (
        <div className="toast" data-tone={toast.tone} data-toast={toast.code}>
          <Icon name={ICON[toast.tone]} size={18} style={{ marginTop: 6 }} />
          <p>{toast.message}</p>
          <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={dismiss}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
