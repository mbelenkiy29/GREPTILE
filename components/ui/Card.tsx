import type { ReactNode } from "react";

/** A bordered surface with an optional header (title + actions) and footer. */
export function Card({
  title,
  titleId,
  description,
  actions,
  footer,
  flush = false,
  children,
  as: Tag = "section",
  className,
}: {
  title?: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Children fill the card edge to edge (tables). */
  flush?: boolean;
  children?: ReactNode;
  as?: "section" | "div" | "article";
  className?: string;
}) {
  return (
    <Tag className={["card", flush && "card-flush", className].filter(Boolean).join(" ")} aria-labelledby={title && titleId ? titleId : undefined}>
      {(title || actions) && (
        <div className="card-head">
          <div className="stack-sm" style={{ gap: 2 }}>
            {title && <h2 id={titleId}>{title}</h2>}
            {description && <p className="dim">{description}</p>}
          </div>
          {actions && <div className="row-tight">{actions}</div>}
        </div>
      )}
      {flush ? children : children !== undefined && <div className="card-body">{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </Tag>
  );
}
