import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SetupFrame } from "@/components/setup/SetupFrame";
import { Alert } from "@/components/ui/Alert";
import { CodeBlock } from "@/components/ui/Code";
import { randomToken } from "@/lib/crypto";
import { log } from "@/lib/log";
import { outboundFetch } from "@/lib/net/fetch";
import { completeManifestSetup, envLines, SETUP_COOKIE } from "@/lib/setup/github-app";
import { setupContext } from "@/lib/setup/next";

// Rendered per request and never cached: the page shows the new App's secrets exactly once.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const metadata = { title: "GitHub App created", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * GitHub redirects here after creating the App from the manifest (R6.25). The one-time code is exchanged for the App's
 * credentials, which are shown once for the operator to copy into `.env`; OpenReview does not store them.
 */
export default async function GitHubAppSetupCallbackPage({ searchParams }: { searchParams: Search }) {
  const { env, access } = await setupContext();
  if (!access.allowed) {
    if (access.reason === "sign_in") redirect("/sign-in?next=%2Fsetup%2Fgithub-app");
    notFound();
  }
  if (!env.APP_SECRET) redirect("/setup/github-app");
  const sp = await searchParams;
  const result = await completeManifestSetup(
    { fetch: outboundFetch, appSecret: env.APP_SECRET, githubApiUrl: env.GITHUB_API_URL, githubWebUrl: env.GITHUB_WEB_URL },
    { code: one(sp.code), state: one(sp.state), nonce: (await cookies()).get(SETUP_COOKIE)?.value },
  );
  const slog = log.child({ component: "setup" });
  if (!result.ok) {
    slog.warn("GitHub App setup could not be completed", { error: result.error });
    return (
      <SetupFrame title="GitHub App setup failed">
        <Alert tone="error">{result.message}</Alert>
        <a className="button button-primary button-block" href="/setup/github-app">
          Start again
        </a>
      </SetupFrame>
    );
  }
  const { app } = result;
  slog.info("GitHub App created from the manifest", { appId: app.id, slug: app.slug, owner: app.owner });
  // GitHub normally generates the webhook secret; if it did not, use a new random one and set it on GitHub.
  const webhookSecret = app.webhookSecret ?? randomToken(32);
  const settingsUrl = app.settingsUrl;
  return (
    <SetupFrame title="GitHub App created">
      <Alert tone="warning" title="Copy these now">
        They are shown only once and OpenReview does not keep them. Reloading this page will not show them again.
      </Alert>
      <p>
        Created <strong>{app.name}</strong>
        {app.owner ? <> for <strong>{app.owner}</strong></> : null} (App ID {app.id}). Add these lines to <code>.env</code> on the server, replacing any
        existing <code>GITHUB_APP_*</code> and <code>GITHUB_WEBHOOK_SECRET</code> values:
      </p>
      <CodeBlock code={envLines(app, webhookSecret)} title=".env" />
      {!app.webhookSecret && (
        <Alert tone="warning" title="Set the webhook secret on GitHub">
          GitHub did not return a webhook secret. Open the{" "}
          <a href={settingsUrl} rel="noreferrer">
            App&apos;s settings
          </a>
          , paste the <code>GITHUB_WEBHOOK_SECRET</code> value above into <strong>Webhook secret</strong>, and save.
        </Alert>
      )}
      <p>Then restart OpenReview so it picks them up:</p>
      <CodeBlock code={"docker compose up -d   # recreates the app and worker with the new .env"} title="shell" copy={false} />
      <p>
        Finally, install the App on the repositories to review from the dashboard (<strong>Repositories → Install</strong>), or from the{" "}
        <a href={app.htmlUrl ?? settingsUrl} rel="noreferrer">
          App&apos;s page on GitHub
        </a>
        .
      </p>
    </SetupFrame>
  );
}
