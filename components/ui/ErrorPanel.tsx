import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/** A centered status panel for error, not-found, and forbidden pages. Never shows stack traces. */
export function ErrorPanel({
  icon = "alert",
  code,
  title,
  children,
  actions,
}: {
  icon?: IconName;
  code?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-state" role="alert" data-error-panel={code}>
      <span className="empty-state-icon" style={{ background: "var(--bad-bg)", color: "var(--bad-fg)" }}>
        <Icon name={icon} size={24} />
      </span>
      {code && <span className="eyebrow">{code}</span>}
      <h1 style={{ fontSize: "var(--text-xl)" }}>{title}</h1>
      {children && <div className="stack-sm" style={{ justifyItems: "center" }}>{children}</div>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}
