// Sign-in choices for the providers this deployment has configured; `next` returns the user to a
// same-origin page (e.g. an invitation) after signing in.
import Link from "next/link";
import { emailOnWeb } from "../src/email";

export function SignInOptions({ next }: { next?: string }) {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  const email = emailOnWeb();
  return <div className="sign-in-options">
    <a className="button primary" href={`/api/auth/login${q}`}>Sign in with GitHub</a>
    {process.env.GITLAB_OAUTH_CLIENT_ID && <a className="button" href={`/api/auth/gitlab/login${q}`}>Sign in with GitLab</a>}
    {process.env.GOOGLE_CLIENT_ID && <a className="button" href={`/api/auth/google/login${q}`}>Sign in with Google</a>}
    {email && <form action="/api/auth/email" method="post" className="email-sign-in">
      {next && <input type="hidden" name="next" value={next} />}
      <label>Email<input type="email" name="email" required maxLength={254} autoComplete="email" /></label>
      <button>Email me a sign-in link</button>
    </form>}
    <p className="sign-in-legal">By signing in you agree to the <Link href="/terms">Terms of Service</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
  </div>;
}
