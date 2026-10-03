"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** Copies `value` to the clipboard and confirms it (announced politely to screen readers). */
export function CopyButton({ value, label = "Copy", compact = false }: { value: string; label?: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <button
      type="button"
      className={compact ? "icon-button" : "button button-sm"}
      aria-label={compact ? text : undefined}
      title={compact ? text : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          // Clipboard access needs a secure origin; the text stays selectable for manual copying.
          setState("failed");
        }
      }}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
      {!compact && <span>{text}</span>}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Couldn't copy" : ""}
      </span>
    </button>
  );
}
