import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { authConfig, devLoginAllowed } from "@/lib/auth/config";
import { signInErrorMessage } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";
import { Brand } from "@/components/shell/Brand";
import { Alert } from "@/components/ui/Alert";
import { Input } from "@/components/ui/Field";
import { Icon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

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
    <main className="auth-page">
      <div className="auth-card">
        <div className="stack-md">
          <Brand href="/" />
          <div className="stack-sm">
            <h1>Sign in</h1>
            <p className="dim">Use your GitHub account, or your organization&apos;s single sign-on. With GitHub we only read your profile, your verified email, and which App installations you can access.</p>
          </div>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {githubReady ? (
          <a className="button button-primary button-block button-lg" href={startUrl}>
            <Icon name="github" size={18} />
            Continue with GitHub
          </a>
        ) : (
          <Alert tone="info" title="GitHub sign-in isn't configured yet">
            Set <code>GITHUB_APP_CLIENT_ID</code> and <code>GITHUB_APP_CLIENT_SECRET</code> to the GitHub App&apos;s OAuth credentials.
          </Alert>
        )}
        <form method="post" action="/api/auth/sso" className="stack-sm" data-testid="sso-sign-in">
          <input type="hidden" name="next" value={next} />
          <Input
            id="sso-identifier"
            name="identifier"
            label="Single sign-on"
            help="Your work email, or your organization's slug."
            type="text"
            autoComplete="email"
            required
            maxLength={320}
            placeholder="you@company.com"
          />
          <button className="button button-block" type="submit">
            Sign in with SSO
          </button>
        </form>
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
