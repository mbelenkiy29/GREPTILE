import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { authConfig, devLoginAllowed } from "@/lib/auth/config";
import { signInErrorMessage } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · OpenReview" };

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SignInPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const error = signInErrorMessage(first(params.error));
  // Already signed in: continue, unless a sign-in error is being reported (avoids redirect loops on failures).
  if (!error && (await getSession())) redirect(next);

  const config = authConfig();
  const githubReady = Boolean(config.githubClientId && config.githubClientSecret);
  const devLogin = devLoginAllowed(config);
  const startUrl = `/api/auth/github?${new URLSearchParams({ next }).toString()}`;

  return (
    <main className="shell auth-page">
      <div className="auth-card">
        <div className="stack-sm">
          <span className="brand">OpenReview</span>
          <h1>Sign in</h1>
          <p className="dim">Use your GitHub account. We only read your profile, your verified email, and which App installations you can access.</p>
        </div>
        {error && (
          <p className="notice notice-bad" role="alert">
            {error}
          </p>
        )}
        {githubReady ? (
          <a className="button button-primary button-block" href={startUrl}>
            Continue with GitHub
          </a>
        ) : (
          <p className="notice">
            GitHub sign-in isn&apos;t configured yet. Set <code>GITHUB_APP_CLIENT_ID</code> and <code>GITHUB_APP_CLIENT_SECRET</code> to
            the GitHub App&apos;s OAuth credentials.
          </p>
        )}
        {devLogin && (
          <form method="post" action="/api/auth/dev" className="stack-sm">
            <input type="hidden" name="next" value={next} />
            <button className="button button-block" type="submit">
              Continue as local developer
            </button>
            <span className="dim">Development only (AUTH_DEV_LOGIN). Never available in production.</span>
          </form>
        )}
      </div>
    </main>
  );
}
