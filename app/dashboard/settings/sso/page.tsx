import type { Metadata } from "next";
import Link from "next/link";
import { StatefulForm } from "@/components/enterprise/StatefulForm";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getSession, requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { authEnv } from "@/lib/env";
import { listSsoConnections, type SsoConnectionView } from "@/lib/sso/connections";
import { oidcRedirectUri } from "@/lib/sso/handlers";
import { samlAcsUrl, samlEntityId } from "@/lib/sso/saml";
import { enumParam, type SearchParams } from "@/lib/ui/url";
import {
  deleteSsoConnectionAction,
  saveSsoConnectionAction,
  setSsoEnforcementAction,
  testSsoConnectionAction,
  toggleSsoConnectionAction,
} from "./actions";

export const metadata: Metadata = { title: "Single sign-on" };

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
] as const;

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input className="input mono" readOnly value={value} aria-label={label} style={{ minWidth: 0 }} />
        <CopyButton value={value} label="Copy" compact />
      </div>
    </div>
  );
}

/** Connection fields; `c` is the connection being edited (its secret is never sent to the page). */
function ConnectionFields({ protocol, c }: { protocol: "oidc" | "saml"; c?: SsoConnectionView }) {
  const p = c?.id ?? `new-${protocol}`;
  return (
    <>
      {c ? <input type="hidden" name="connectionId" value={c.id} /> : <input type="hidden" name="protocol" value={protocol} />}
      <Input id={`${p}-name`} name="name" label="Name" required maxLength={80} defaultValue={c?.name ?? ""} placeholder="Company IdP" />
      {protocol === "oidc" ? (
        <>
          <Input
            id={`${p}-issuer`}
            name="issuer"
            label="Issuer URL"
            help="The issuer (or its /.well-known/openid-configuration URL)."
            required
            defaultValue={c?.issuer ?? ""}
            placeholder="https://login.example.com/realms/acme"
          />
          <Input id={`${p}-client`} name="clientId" label="Client ID" required defaultValue={c?.clientId ?? ""} autoComplete="off" />
          <Input
            id={`${p}-secret`}
            name="clientSecret"
            label="Client secret"
            type="password"
            autoComplete="new-password"
            required={!c?.hasClientSecret}
            help={c?.hasClientSecret ? "A secret is saved and never shown. Leave blank to keep it." : "Stored encrypted; never shown again."}
          />
        </>
      ) : (
        <>
          <Textarea
            id={`${p}-metadata`}
            name="samlMetadata"
            label="IdP metadata XML"
            help="Paste the identity provider's metadata, or fill in the three fields below instead."
            rows={4}
            className="mono"
          />
          <Input id={`${p}-entity`} name="issuer" label="IdP entity ID" defaultValue={c?.issuer ?? ""} placeholder="https://idp.example.com/metadata" />
          <Input id={`${p}-sso`} name="samlSsoUrl" label="IdP SSO URL (HTTP-Redirect)" defaultValue={c?.samlSsoUrl ?? ""} placeholder="https://idp.example.com/sso" />
          <Textarea
            id={`${p}-cert`}
            name="samlCertificate"
            label="IdP signing certificate (PEM)"
            help={c?.samlCertificates.length ? `${c.samlCertificates.length} certificate(s) saved. Leave blank to keep them.` : undefined}
            rows={3}
            className="mono"
          />
        </>
      )}
      <Input
        id={`${p}-domains`}
        name="allowedDomains"
        label="Allowed email domains"
        help="Only these domains may sign in, e.g. example.com, example.org."
        required
        defaultValue={c?.allowedDomains.join(", ") ?? ""}
      />
      <Select id={`${p}-role`} name="defaultRole" label="Role for new members" options={ROLE_OPTIONS} defaultValue={c?.defaultRole ?? "member"} />
    </>
  );
}

function ConnectionCard({ c, appUrl, hasSso }: { c: SsoConnectionView; appUrl: string; hasSso: boolean }) {
  const config = { appUrl };
  return (
    <Card
      title={c.name}
      titleId={`sso-${c.id}`}
      description={c.protocol === "oidc" ? `OpenID Connect · ${c.issuer}` : `SAML 2.0 · ${c.issuer}`}
      actions={
        <>
          <Badge tone={c.enabled ? "ok" : "muted"} dot>
            {c.enabled ? "Enabled" : "Disabled"}
          </Badge>
          {c.enforce && <Badge tone="accent">Required</Badge>}
        </>
      }
    >
      <div className="stack-md" data-sso-connection={c.id}>
        <div className="stack-sm">
          <strong>Give these to your identity provider</strong>
          {c.protocol === "oidc" ? (
            <UrlRow label="Redirect URI" value={oidcRedirectUri(config, c.id)} />
          ) : (
            <>
              <UrlRow label="ACS URL" value={samlAcsUrl(appUrl, c.id)} />
              <UrlRow label="SP entity ID / metadata URL" value={samlEntityId(appUrl, c.id)} />
            </>
          )}
        </div>
        <StatefulForm action={testSsoConnectionAction} className="row">
          <input type="hidden" name="connectionId" value={c.id} />
          <SubmitButton size="sm" pendingLabel="Testing…">
            Test connection
          </SubmitButton>
          <a className="button button-sm" href={`/api/auth/sso/${c.id}/start?next=${encodeURIComponent("/dashboard/settings/sso")}`}>
            Sign in through it
          </a>
        </StatefulForm>
        <StatefulForm action={setSsoEnforcementAction} className="stack-sm">
          <input type="hidden" name="connectionId" value={c.id} />
          <input type="hidden" name="enforce" value={c.enforce ? "false" : "true"} />
          <p className="dim">
            {c.enforce
              ? "Members must sign in through this connection to use the organization, including those who signed in with GitHub."
              : hasSso
                ? "Require members to sign in through this connection."
                : "To require it, first sign in through it yourself (“Sign in through it”), so you can't lock everyone out."}
          </p>
          <div>
            <SubmitButton size="sm" variant={c.enforce ? "default" : "primary"} disabled={!c.enforce && (!hasSso || !c.enabled)}>
              {c.enforce ? "Stop requiring SSO" : "Require SSO"}
            </SubmitButton>
          </div>
        </StatefulForm>
        <details>
          <summary>Edit connection</summary>
          <StatefulForm action={saveSsoConnectionAction} testId={`sso-edit-${c.id}`}>
            <ConnectionFields protocol={c.protocol} c={c} />
            <div>
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </div>
          </StatefulForm>
        </details>
        <div className="row">
          <form action={toggleSsoConnectionAction}>
            <input type="hidden" name="connectionId" value={c.id} />
            <input type="hidden" name="enabled" value={c.enabled ? "false" : "true"} />
            <SubmitButton size="sm">{c.enabled ? "Disable" : "Enable"}</SubmitButton>
          </form>
          <form action={deleteSsoConnectionAction}>
            <input type="hidden" name="connectionId" value={c.id} />
            <ConfirmButton prompt={`Delete ${c.name}?`} confirmLabel="Delete">
              Delete
            </ConfirmButton>
          </form>
        </div>
      </div>
    </Card>
  );
}

/** Settings → Single sign-on (R4.6): OIDC and SAML connections, owners only. */
export default async function SsoSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireOrg({ permission: "sso.manage" });
  const protocol = enumParam(await searchParams, "protocol", ["oidc", "saml"] as const) ?? "oidc";
  const [connections, session] = await Promise.all([listSsoConnections(db(), ctx.orgId), getSession()]);
  const appUrl = authEnv().APP_URL.replace(/\/$/, "");
  const hasSso = Boolean(session?.ssoOrgIds.includes(ctx.orgId));
  if (ctx.personal) {
    return <Alert tone="info">Single sign-on is available for team organizations. Create one from the organization switcher.</Alert>;
  }
  return (
    <>
      <Alert tone="info">
        People who sign in through a connection with an email in its allowed domains join {ctx.orgName} with the role you choose. Signing in starts at{" "}
        <strong>Sign in with SSO</strong> on the sign-in page (work email or the slug <code>{ctx.orgSlug}</code>).
      </Alert>
      {connections.map((c) => (
        <ConnectionCard key={c.id} c={c} appUrl={appUrl} hasSso={hasSso} />
      ))}
      <Card
        title="Add a connection"
        titleId="sso-new"
        description="Client secrets are encrypted at rest and never shown again."
        actions={
          <nav className="row-tight" aria-label="Protocol">
            <Link className="button button-sm" aria-current={protocol === "oidc" ? "page" : undefined} href="?protocol=oidc">
              OpenID Connect
            </Link>
            <Link className="button button-sm" aria-current={protocol === "saml" ? "page" : undefined} href="?protocol=saml">
              SAML 2.0
            </Link>
          </nav>
        }
      >
        <StatefulForm action={saveSsoConnectionAction} testId="sso-create">
          <ConnectionFields protocol={protocol} />
          <div>
            <SubmitButton pendingLabel="Saving…">Add {protocol === "oidc" ? "OIDC" : "SAML"} connection</SubmitButton>
          </div>
        </StatefulForm>
      </Card>
    </>
  );
}
