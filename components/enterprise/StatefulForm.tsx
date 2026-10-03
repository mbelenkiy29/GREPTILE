"use client";

import { useActionState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";

/** What a settings server action reports back to its form: an error, or a status with detail lines. */
export interface FormResult {
  error?: string;
  ok?: boolean;
  lines?: string[];
}

/**
 * A form bound to a server action through `useActionState`, showing the action's error or result above the fields.
 * Fields are server-rendered children, so the form works the same with or without JavaScript.
 */
export function StatefulForm({
  action,
  children,
  className = "stack-md",
  testId,
}: {
  action: (prev: FormResult, formData: FormData) => Promise<FormResult>;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className} data-testid={testId}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.lines && state.lines.length > 0 && (
        <Alert tone={state.ok ? "success" : "error"} title={state.ok ? "Check passed" : "Check failed"} role="status">
          <ul className="stack-sm">
            {state.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Alert>
      )}
      {children}
    </form>
  );
}
