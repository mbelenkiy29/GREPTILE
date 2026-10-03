import type { ReactNode } from "react";

/**
 * A CSS-only tooltip shown on hover and on keyboard focus. The trigger is focusable and described by the tip, so
 * screen readers announce it too. Keep tips short and never the only place information appears.
 */
export function Tooltip({ tip, id, children }: { tip: string; id: string; children: ReactNode }) {
  return (
    <span className="tooltip">
      <span tabIndex={0} aria-describedby={id} style={{ display: "inline-flex" }}>
        {children}
      </span>
      <span className="tooltip-bubble" role="tooltip" id={id}>
        {tip}
      </span>
    </span>
  );
}
