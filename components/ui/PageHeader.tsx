import type { ReactNode } from "react";
import { Breadcrumbs } from "./Breadcrumbs";

/** Page title block: optional breadcrumbs, the h1, a one-line description, and page actions. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  /** Pills or facts under the title. */
  meta?: ReactNode;
}) {
  return (
    <div className="stack-sm">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="break">{title}</h1>
          {description && <p>{description}</p>}
          {meta && <div className="row-tight" style={{ marginTop: 4 }}>{meta}</div>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </div>
  );
}
