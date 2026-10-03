import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SetupFrame } from "@/components/setup/SetupFrame";
import { Alert } from "@/components/ui/Alert";
import { CodeBlock } from "@/components/ui/Code";
import { Checkbox, Input } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import {
  APP_NAME_MAX,
  buildManifest,
  defaultAppName,
  isGitHubAppConfigured,
  isSetupField,
  manifestFormAction,
  SETUP_COOKIE,
  SETUP_FIELD_ERRORS,
  setupFormSchema,
  signSetupState,
} from "@/lib/setup/github-app";
import { setupContext } from "@/lib/setup/next";
import { startGitHubAppSetup } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up the GitHub App", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function isPublicHttps(appUrl: string): boolean {
  const u = new URL(appUrl);
  return u.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/**
 * Creates this server's GitHub App through GitHub's manifest flow (R6.25). Step 1 picks the account and name; step 2
 * posts the manifest to GitHub, which redirects to `/setup/github-app/callback` with a one-time code.
 */
export default async function GitHubAppSetupPage({ searchParams }: { searchParams: Search }) {
  const { env, access } = await setupContext();
  if (!access.allowed) {
    if (access.reason === "sign_in") redirect("/sign-in?next=%2Fsetup%2Fgithub-app");
    notFound();
  }
  const sp = await searchParams;
  const configured = isGitHubAppConfigured(env);

  if (!env.APP_SECRET) {
    return (
      <SetupFrame title="Set up the GitHub App">
        <Alert tone="error" title="APP_SECRET is not set">
          Set <code>APP_SECRET</code> in <code>.env</code> to a random string of at least 16 characters (for example the output of{" "}
          <code>openssl rand -base64 32</code>), restart the app, and reload this page.
        </Alert>
      </SetupFrame>
    );
  }

  const notices = (
    <>
      {configured && (
        <Alert tone="warning" title="A GitHub App is already configured">
          This server uses the App <code>{env.GITHUB_APP_SLUG}</code>. Creating another one replaces it only after you put its credentials in{" "}
          <code>.env</code> and restart; installations of the current App stop working then.
        </Alert>
      )}
      {!isPublicHttps(env.APP_URL) && (
        <Alert tone="warning" title="GitHub cannot reach this address">
          <code>APP_URL</code> is <code>{env.APP_URL}</code>. GitHub sends webhooks to <code>{env.APP_URL}/api/webhooks/github</code>, so set{" "}
          <code>APP_URL</code> to this server&apos;s public https address first (or use a tunnel for local development).
        </Alert>
      )}
    </>
  );

  const nonce = (await cookies()).get(SETUP_COOKIE)?.value;
  const create = one(sp.step) === "create" && nonce ? setupFormSchema.safeParse({ owner: one(sp.owner) ?? "", name: one(sp.name) ?? "", public: one(sp.public) === "1" }) : null;
  if (create?.success && nonce) {
    const { owner, name } = create.data;
    const manifest = buildManifest(env.APP_URL, { name, public: create.data.public });
    const action = manifestFormAction(env.GITHUB_WEB_URL, owner, signSetupState(env.APP_SECRET, nonce));
    return (
      <SetupFrame title="Create the GitHub App">
        {notices}
        <p>
          GitHub will create <strong>{name}</strong> {owner ? <>in the organization <strong>{owner}</strong></> : "under your personal account"} with
          the permissions and events below, then send you back here to collect its credentials.
        </p>
        <CodeBlock code={JSON.stringify(manifest, null, 2)} title="App manifest" copy={false} />
        <form method="post" action={action} className="stack-sm">
          <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
          <button className="button button-primary button-block" type="submit">
            Create the App on GitHub
          </button>
        </form>
        <a className="button button-block" href="/setup/github-app">
          Back
        </a>
      </SetupFrame>
    );
  }

  const invalid = one(sp.invalid);
  const field = isSetupField(invalid) ? invalid : null;
  return (
    <SetupFrame title="Set up the GitHub App">
      {notices}
      <p>
        OpenReview talks to GitHub through a GitHub App that you own. This page creates it with the right permissions, events, webhook URL, and
        sign-in callback, then shows its credentials once so you can put them in <code>.env</code>. Nothing is stored on this server.
      </p>
      <form action={startGitHubAppSetup} className="stack-sm">
        <Input
          name="owner"
          label="GitHub organization (optional)"
          placeholder="acme"
          autoComplete="off"
          spellCheck={false}
          defaultValue={one(sp.owner) ?? ""}
          error={field === "owner" ? SETUP_FIELD_ERRORS.owner : null}
          help="Leave empty to create the App under your personal GitHub account. You need to be an owner of the organization."
        />
        <Input
          name="name"
          label="App name"
          required
          maxLength={APP_NAME_MAX}
          defaultValue={one(sp.name) ?? defaultAppName(env.APP_URL)}
          error={field === "name" ? SETUP_FIELD_ERRORS.name : null}
          help="Must be unique on GitHub. Shown on pull request comments."
        />
        <Checkbox id="f-public" name="public" defaultChecked={one(sp.public) === "1"} label="Let other GitHub accounts install it (public App)" />
        <SubmitButton variant="primary" block pendingLabel="Preparing…">
          Continue
        </SubmitButton>
      </form>
    </SetupFrame>
  );
}
