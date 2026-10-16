// Sign-in choices for the providers this deployment has configured; `next` returns the user to a
// same-origin page (e.g. an invitation) after signing in. The same choices create an account.
import Link from "next/link";
import { emailOnWeb } from "../src/email";
import { authProviders, providerLoginPaths, providerNames, type AuthMode } from "../src/auth-pages";
import { ProviderIcon } from "./ui/provider-icons";

export function SignInOptions({ next, mode = "login" }: { next?: string; mode?: AuthMode }) {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  const providers = authProviders(), email = emailOnWeb();
  return <div className="sign-in-options">
    {providers.map((p, i) => <a key={p} className={`button sign-in-provider${i === 0 ? " primary" : ""}`} href={providerLoginPaths[p] + q}><ProviderIcon provider={p} /> Continue with {providerNames[p]}</a>)}
    {email && <>
      {providers.length > 0 && <p className="sign-in-divider"><span>or</span></p>}
      <form action="/api/auth/email" method="post" className="email-sign-in">
        {next && <input type="hidden" name="next" value={next} />}
        <input type="hidden" name="from" value={mode} />
        <label>Work email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" /></label>
        <button>Email me a sign-in link</button>
      </form>
    </>}
    <p className="sign-in-legal">By continuing you agree to the <Link href="/terms">Terms of Service</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
  </div>;
}
