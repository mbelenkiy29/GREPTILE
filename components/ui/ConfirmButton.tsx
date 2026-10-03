"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button, buttonClass, type ButtonSize } from "./Button";

/**
 * A destructive submit button that asks first: the first click turns it into "Confirm" and "Cancel"; only "Confirm"
 * submits the surrounding form. Focus moves to the confirm button so keyboard users can answer right away.
 */
export function ConfirmButton({
  children,
  confirmLabel = "Confirm",
  prompt,
  size = "sm",
}: {
  children: ReactNode;
  confirmLabel?: string;
  /** Short question shown while confirming, e.g. "Delete this rule?" */
  prompt: string;
  size?: ButtonSize;
}) {
  const [asking, setAsking] = useState(false);
  const { pending } = useFormStatus();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (wasAsking.current) triggerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <button ref={triggerRef} type="button" className={buttonClass("danger", size)} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="row-tight" role="group" aria-label={prompt}>
      <span className="dim">{prompt}</span>
      <button ref={confirmRef} type="submit" className={buttonClass("danger", size)} disabled={pending} aria-busy={pending || undefined}>
        {pending && <span className="spinner" aria-hidden="true" />}
        {confirmLabel}
      </button>
      <Button type="button" size={size} variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
        Cancel
      </Button>
    </span>
  );
}
