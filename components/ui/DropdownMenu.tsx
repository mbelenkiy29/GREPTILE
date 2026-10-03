"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

/**
 * An accessible menu button (WAI-ARIA menu pattern). The trigger toggles the menu; ArrowDown/ArrowUp/Home/End move
 * between items, Escape closes and returns focus to the trigger, Tab or a click outside closes it. Children are the
 * items: elements with `role="menuitem"` (see `menuItemProps` in ./menu); wrappers such as forms take `role="none"`.
 */
export function DropdownMenu({
  trigger,
  label,
  align = "start",
  testId,
  className,
  children,
}: {
  trigger: ReactNode;
  /** Accessible name of the trigger. */
  label: string;
  align?: "start" | "end" | "up";
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpenState] = useState(false);
  // The panel is positioned against the viewport so it is never clipped by a scrolling container (e.g. a table).
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (next) {
        const r = buttonRef.current?.getBoundingClientRect();
        if (r) {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          setPosition(
            align === "up"
              ? { position: "fixed", left: Math.max(8, r.left), bottom: vh - r.top + 6, top: "auto" }
              : align === "end"
                ? { position: "fixed", right: Math.max(8, vw - r.right), left: "auto", top: r.bottom + 6 }
                : { position: "fixed", left: Math.max(8, Math.min(r.left, vw - 248)), top: r.bottom + 6 },
          );
        }
      }
      setOpenState(next);
    },
    [align],
  );

  const items = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not(:disabled)') ?? []),
    [],
  );

  const focusItem = useCallback(
    (which: "first" | "last" | "next" | "prev") => {
      const list = items();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const target =
        which === "first" ? 0 : which === "last" ? list.length - 1 : which === "next" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[target]?.focus();
    },
    [items],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // A fixed panel would drift from its trigger on scroll or resize; close it instead.
    const close = (e: Event) => {
      if (e.type === "resize" || !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, setOpen]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => focusItem(e.key === "ArrowDown" ? "first" : "last"));
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusItem("next");
        break;
      case "ArrowUp":
        e.preventDefault();
        focusItem("prev");
        break;
      case "Home":
        e.preventDefault();
        focusItem("first");
        break;
      case "End":
        e.preventDefault();
        focusItem("last");
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div className={["dropdown", className].filter(Boolean).join(" ")} ref={rootRef} data-testid={testId}>
      <button
        ref={buttonRef}
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-label={label}
        onClick={() => {
          setOpen(!open);
          if (!open) requestAnimationFrame(() => focusItem("first"));
        }}
        onKeyDown={onTriggerKey}
      >
        {trigger}
      </button>
      <div
        ref={menuRef}
        id={`${id}-menu`}
        role="menu"
        aria-label={label}
        className="dropdown-panel"
        data-align={align === "start" ? undefined : align}
        hidden={!open}
        style={position}
        onKeyDown={onMenuKey}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('[role="menuitem"]')) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
