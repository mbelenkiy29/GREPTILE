"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function PortalDisclosure({ className, label, children }: {
  className: string; label: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const details = ref.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const details = ref.current;
      if (event.key !== "Escape" || !details?.open || event.defaultPrevented) return;
      event.preventDefault();
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return <details ref={ref} className={className} name="portal-menu"><summary>{label}</summary>{children}</details>;
}
