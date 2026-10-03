import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import type { UsageBanner } from "@/lib/billing/alerts";

/** Usage alert banners (R4.3): one per limit at or past the org's lowest alert threshold. */
export function UsageBanners({ banners }: { banners: UsageBanner[] }) {
  if (!banners.length) return null;
  return (
    <div className="stack-sm" data-usage-banners="">
      {banners.map((b) => (
        <Alert key={b.metric} tone={b.tone} title={b.tone === "error" ? "Usage limit reached" : "Approaching a usage limit"} role={b.tone === "error" ? "alert" : "status"}>
          <p>
            {b.message} <Link href="/dashboard/settings/usage">Usage &amp; billing</Link>
          </p>
        </Alert>
      ))}
    </div>
  );
}
