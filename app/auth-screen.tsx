// Sign-in and sign-up screens: the choices on the left, a code-graph drawing on the right (hidden on
// small screens). Both pages use the same sign-in flows; only the wording differs.
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "../convex/_generated/api";
import { billingConfig } from "../src/billing";
import { safeNext } from "../src/identity";
import { backend } from "../src/server";
import { authMessage, keepsAuthPage, type AuthMode } from "../src/auth-pages";
import { IndexGraph } from "./dashboard/onboarding/art";
import { SignInOptions } from "./sign-in";
import { Mark } from "./ui/logo";

export type AuthQuery = { next?: string; error?: string; email?: string; signedout?: string };

/** Signed-in visitors skip the page and go where they were headed, unless it shows a result. */
export async function redirectIfSignedIn(query: AuthQuery) {
  if (keepsAuthPage(query)) return;
  const token = (await cookies()).get("openreview_session")?.value;
  if (token && await backend().query(api.identity.sessionValid, { token }).catch(() => false)) redirect(safeNext(query.next));
}

// A small, fixed sample of a repository so the drawing reads as real files and references.
const sample = [{ repository: "acme/shop", files: ["src/cart.ts", "src/billing.ts", "src/checkout.ts", "src/tax.ts", "src/api/orders.ts", "src/api/refunds.ts", "lib/money.ts", "lib/currency.ts", "test/cart.test.ts", "test/billing.test.ts", "app/page.tsx", "app/checkout/page.tsx"], edges: [["src/checkout.ts", "src/cart.ts"], ["src/checkout.ts", "src/billing.ts"], ["src/billing.ts", "lib/money.ts"], ["src/tax.ts", "lib/money.ts"], ["lib/money.ts", "lib/currency.ts"], ["src/api/orders.ts", "src/checkout.ts"], ["src/api/refunds.ts", "src/billing.ts"], ["test/cart.test.ts", "src/cart.ts"], ["test/billing.test.ts", "src/billing.ts"], ["app/checkout/page.tsx", "src/api/orders.ts"], ["app/page.tsx", "src/cart.ts"]] as [string, string][] }];

export function AuthScreen({ mode, query }: { mode: AuthMode; query: AuthQuery }) {
  const next = query.next ? safeNext(query.next) : undefined, message = authMessage(query);
  const carry = next ? `?next=${encodeURIComponent(next)}` : "", billing = billingConfig();
  return <div className="auth">
    <main className="auth-panel">
      <Link className="brand" href="/"><Mark /> OpenReview</Link>
      <div className="auth-card">
        <h1>{mode === "login" ? "Sign in to OpenReview" : "Create your account"}</h1>
        <p className="auth-switch">{mode === "login"
          ? <>New to OpenReview? <Link href={`/signup${carry}`}>Create an account</Link></>
          : <>Already have an account? <Link href={`/login${carry}`}>Sign in</Link></>}</p>
        {mode === "signup" && billing.enabled && <p className="auth-note">Free for {billing.trialDays} days, starting with your first review. No card needed.</p>}
        {message && <p role={message.tone} className={message.tone === "alert" ? "error" : "auth-status"}>{message.text}</p>}
        <SignInOptions next={next} mode={mode} />
      </div>
    </main>
    <aside className="auth-art" aria-hidden="true">
      <figure><IndexGraph samples={sample} processed={1} total={1} complete /></figure>
      <p>Reviews that read the whole repository</p>
    </aside>
  </div>;
}
