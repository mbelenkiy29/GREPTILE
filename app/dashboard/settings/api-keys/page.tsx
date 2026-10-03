import type { Metadata } from "next";
import { CreateApiKeyForm } from "@/components/apikeys/CreateApiKeyForm";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { CodeBlock } from "@/components/ui/Code";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { EXPIRY_OPTIONS } from "@/lib/api/key-admin";
import { API_SCOPES, displayKey, keyState, listApiKeys, SCOPE_LABEL } from "@/lib/api/keys";
import { db } from "@/lib/db";
import { apiEnv } from "@/lib/env";
import { formatDate, formatRelative } from "@/lib/ui/format";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

export const metadata: Metadata = { title: "API keys" };

const STATE_TONE = { active: "ok", revoked: "muted", expired: "warn" } as const;

/** Org API keys (R6.18): create (token shown once), list with scopes and last use, and revoke. */
export default async function ApiKeysPage() {
  const { orgId, orgName } = await requireOrg({ permission: "apikeys.manage" });
  const keys = await listApiKeys(db(), orgId);
  const now = new Date();
  const base = `${apiEnv().APP_URL.replace(/\/$/, "")}/api/v1`;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/dashboard/settings" }, { label: "API keys" }]}
        title="API keys"
        description={`Keys for the REST API act as ${orgName}, limited to the scopes you choose.`}
      />
      <Card title="Create a key" titleId="create-key-heading" description="Give each integration its own key so you can revoke it on its own.">
        <CreateApiKeyForm action={createApiKeyAction} scopes={API_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))} expiryOptions={EXPIRY_OPTIONS} />
      </Card>
      <Card title="Keys" titleId="keys-heading" flush>
        {keys.length ? (
          <Table caption="API keys">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const state = keyState(k, now);
                return (
                  <tr key={k.id} data-api-key={k.id}>
                    <td className="strong">{k.name}</td>
                    <td className="mono nowrap">{displayKey(k.prefix)}</td>
                    <td>
                      <div className="row-tight">
                        {k.scopes.map((s) => (
                          <Badge key={s} tone="outline" mono>
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="nowrap">{formatDate(k.createdAt)}</td>
                    <td className="nowrap">{k.lastUsedAt ? formatRelative(k.lastUsedAt, now) : "Never"}</td>
                    <td className="nowrap">{k.expiresAt ? formatDate(k.expiresAt) : "Never"}</td>
                    <td>
                      <Badge tone={STATE_TONE[state]} dot>
                        {state === "active" ? "Active" : state === "revoked" ? "Revoked" : "Expired"}
                      </Badge>
                    </td>
                    <td>
                      {state !== "revoked" && (
                        <form action={revokeApiKeyAction}>
                          <input type="hidden" name="keyId" value={k.id} />
                          <SubmitButton size="sm" variant="danger" pendingLabel="Revoking…" aria-label={`Revoke ${k.name}`}>
                            Revoke
                          </SubmitButton>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="card-body dim">No API keys yet.</p>
        )}
      </Card>
      <Card title="Using the API" titleId="usage-heading" description="JSON over HTTPS; errors are { error: { code, message } }.">
        <div className="stack-sm">
          <p>
            Send the key as a bearer token. The OpenAPI document at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> lists every endpoint,
            its scope, and its parameters. Each key may make {apiEnv().API_RATE_LIMIT_PER_MINUTE} requests per minute.
          </p>
          <CodeBlock code={`curl -H "Authorization: Bearer $OPENREVIEW_API_KEY" ${base}/reviews?status=completed`} title="List completed reviews" id="api-example" />
        </div>
      </Card>
    </>
  );
}
