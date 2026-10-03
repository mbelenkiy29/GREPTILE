import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/shell/Brand";
import { Alert } from "@/components/ui/Alert";
import { Input, Select } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { DECISION_ERROR_MESSAGES, findPendingLogin, formatUserCode, normalizeUserCode, type DecisionError } from "@/lib/cli/device";
import { db } from "@/lib/db";
import { listUserOrgs } from "@/lib/data/orgs";
import { decideCliLoginAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in the CLI" };

type Search = Promise<{ code?: string | string[]; error?: string | string[]; done?: string | string[]; host?: string | string[] }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Brand href="/dashboard" />
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function CodeForm({ error }: { error?: string }) {
  return (
    <form method="get" action="/cli/activate" className="stack-sm">
      <Input
        name="code"
        label="Code from your terminal"
        placeholder="BCDF-GHJK"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
        error={error ?? null}
        help="`openreview login` prints this code."
      />
      <button className="button button-primary button-block" type="submit">
        Continue
      </button>
    </form>
  );
}

/**
 * Confirms an `openreview login` (R3.5): the member checks the code matches their terminal, picks the org the CLI
 * should act in, and approves or denies. The CLI then receives an API key for that org.
 */
export default async function CliActivatePage({ searchParams }: { searchParams: Search }) {
  const session = await requireUser();
  const sp = await searchParams;
  const done = one(sp.done);
  if (done === "approved" || done === "denied") {
    const host = one(sp.host);
    return (
      <Frame title={done === "approved" ? "CLI signed in" : "Login denied"}>
        {done === "approved" ? (
          <p>
            You can close this tab and return to your terminal{host ? <> on <strong>{host}</strong></> : null}. The CLI now has an API key, which
            you can revoke any time under <Link href="/dashboard/settings/api-keys">Settings → API keys</Link>.
          </p>
        ) : (
          <p>The CLI was not signed in. If you didn&apos;t start this login, nothing else is needed.</p>
        )}
      </Frame>
    );
  }

  const rawCode = one(sp.code);
  const errorCode = one(sp.error) as DecisionError | undefined;
  const reported = errorCode && errorCode in DECISION_ERROR_MESSAGES ? DECISION_ERROR_MESSAGES[errorCode] : null;
  if (!rawCode) {
    return (
      <Frame title="Sign in the OpenReview CLI">
        {reported && <Alert tone="error">{reported}</Alert>}
        <CodeForm />
      </Frame>
    );
  }
  const code = normalizeUserCode(rawCode);
  const pending = code ? await findPendingLogin(db(), code, new Date()) : undefined;
  if (!code || !pending) {
    return (
      <Frame title="Sign in the OpenReview CLI">
        <CodeForm error={code ? DECISION_ERROR_MESSAGES.not_found : DECISION_ERROR_MESSAGES.invalid_code} />
      </Frame>
    );
  }

  const orgs = await listUserOrgs(db(), session.userId);
  const account = session.user.githubLogin ? `@${session.user.githubLogin}` : (session.user.email ?? session.user.name);
  const defaultOrg = orgs.some((o) => o.id === session.activeOrgId) ? session.activeOrgId! : orgs[0]?.id;
  return (
    <Frame title="Sign in the OpenReview CLI">
      {reported && <Alert tone="error">{reported}</Alert>}
      <p>
        A terminal on <strong>{pending.clientHost}</strong>
        {pending.clientIp ? <> ({pending.clientIp})</> : null} is asking to act as you. Check that it shows this code:
      </p>
      <p className="mono strong" style={{ fontSize: "1.5rem", letterSpacing: "0.15em", textAlign: "center" }} data-user-code>
        {formatUserCode(code)}
      </p>
      <Alert tone="warning">Only approve a login you started yourself. If someone sent you this link, deny it.</Alert>
      {orgs.length === 0 ? (
        <>
          <p className="dim">You aren&apos;t in any organization yet, so there is nothing for the CLI to act in.</p>
          <Link className="button" href="/orgs">
            Go to your organizations
          </Link>
        </>
      ) : (
        <form action={decideCliLoginAction} className="stack-sm">
          <input type="hidden" name="code" value={code} />
          <Select
            name="orgId"
            label="Organization"
            defaultValue={defaultOrg}
            options={orgs.map((o) => ({ value: o.id, label: `${o.name} (${ROLE_LABEL[o.role]})` }))}
            help="The CLI gets an API key for this organization with the access your role allows."
          />
          <div className="row">
            <SubmitButton variant="primary" name="decision" value="approve" pendingLabel="Approving…">
              Approve
            </SubmitButton>
            <SubmitButton variant="danger" name="decision" value="deny" pendingLabel="Denying…">
              Deny
            </SubmitButton>
          </div>
        </form>
      )}
      <p className="dim">
        Signed in as {account}. The code expires at {pending.expiresAt.toISOString().slice(11, 16)} UTC.
      </p>
    </Frame>
  );
}
