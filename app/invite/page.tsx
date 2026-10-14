import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { SignInOptions } from "../sign-in";
import { acceptEmailInvitation } from "../dashboard/actions";

// Email invitation landing: preview the workspace, sign in if needed, then accept (single use).
export default async function Invite({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token = "", error } = await searchParams;
  const valid = /^[A-Za-z0-9_-]{40,64}$/.test(token);
  const preview = valid ? await backend().query(api.identity.invitationPreview, { tokenHash: createHash("sha256").update(token).digest("hex") }) : null;
  const session = (await cookies()).get("openreview_session")?.value;
  const signedIn = session ? await backend().query(api.identity.sessionValid, { token: session }).catch(() => false) : false;
  return <main className="welcome">
    <div className="brand"><span className="mark">⌘</span> OpenReview</div>
    {error && <p role="alert" className="error">This invitation could not be accepted. It may have expired, been revoked or already been used.</p>}
    {!preview ? <><h1>Invitation unavailable</h1><p>This invitation link is invalid, expired, revoked or already used. Ask a workspace admin for a new one.</p></> : <>
      <h1>Join {preview.workspace}</h1>
      <p>You were invited as <strong>{preview.role}</strong>. The link works once and expires {new Date(preview.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" })}.</p>
      {signedIn ? <form action={acceptEmailInvitation}><input type="hidden" name="token" value={token} /><button className="primary">Accept invitation</button></form>
        : <><p>Sign in or create an account to accept.</p><SignInOptions next={`/invite?token=${token}`} /></>}
    </>}
  </main>;
}
