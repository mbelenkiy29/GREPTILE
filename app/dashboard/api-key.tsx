"use client";
import { useActionState } from "react";
import { createApiKey } from "./actions";
export function ApiKeyForm({ organizationId }: { organizationId: string }) {
  const [value, action, pending] = useActionState(createApiKey, "");
  return (
    <>
      <form action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          API key name
          <input name="name" required maxLength={100} />
        </label>
        <button disabled={pending}>Generate API key</button>
      </form>
      {value && (
        <div role="status">
          <p>Copy this key now. It will not be shown again.</p>
          <pre>{value}</pre>
        </div>
      )}
    </>
  );
}
