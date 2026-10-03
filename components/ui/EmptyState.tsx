import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/** What to show when a list or page has nothing yet: an icon, a title, guidance, and the next step. */
export function EmptyState({
  icon = "spark",
  title,
  children,
  actions,
  headingLevel = 2,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="empty-state" data-empty-state="">
      <span className="empty-state-icon">
        <Icon name={icon} size={24} />
      </span>
      <Heading>{title}</Heading>
      {children && <div className="stack-sm" style={{ justifyItems: "center" }}>{children}</div>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}
