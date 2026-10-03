import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type AlertTone = "info" | "success" | "warning" | "error" | "neutral";

const ICONS: Record<AlertTone, IconName> = { info: "info", success: "check", warning: "alert", error: "alert", neutral: "info" };

/** A callout. Errors and warnings are announced (`role="alert"`); others are polite status messages. */
export function Alert({ tone = "info", title, children, role }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode; role?: "alert" | "status" | "note" }) {
  const r = role ?? (tone === "error" ? "alert" : tone === "neutral" ? "note" : "status");
  return (
    <div className={`alert alert-${tone}`} role={r}>
      <Icon name={ICONS[tone]} size={18} />
      <div className="alert-body">
        {title && <div className="alert-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
