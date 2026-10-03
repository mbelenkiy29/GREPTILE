import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { StatusPill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { getDelivery } from "@/lib/data/deliveries";
import { formatDate, formatDuration } from "@/lib/ui/format";
import { replayDeliveryAction } from "../actions";

export const metadata: Metadata = { title: "Webhook delivery" };

export default async function DeliveryPage({ params }: { params: Promise<{ deliveryId: string }> }) {
  const { orgId, role } = await requireOrg();
  // Delivery ids are plain [\w.-] tokens, so the segment needs no decoding; anything else is not found.
  const deliveryId = (await params).deliveryId;
  if (!/^[\w.-]{1,128}$/.test(deliveryId)) notFound();
  const d = await getDelivery(db(), orgId, deliveryId);
  if (!d) notFound();
  const replayable = d.status === "failed" && d.payload !== null && d.payload !== undefined;
  const admin = can(role, "repos.manage");

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Activity", href: "/dashboard/activity?tab=deliveries" }, { label: d.deliveryId }]}
        title={
          <span className="mono">
            {d.event}
            {d.action ? `.${d.action}` : ""}
          </span>
        }
        meta={<StatusPill kind="delivery" value={d.status} />}
        actions={
          admin && replayable ? (
            <form action={replayDeliveryAction}>
              <input type="hidden" name="deliveryId" value={d.deliveryId} />
              <SubmitButton variant="primary" icon="refresh" pendingLabel="Replaying…">
                Replay delivery
              </SubmitButton>
            </form>
          ) : undefined
        }
      />
      {d.status === "failed" && (
        <Alert tone="error" title="Processing failed">
          <span className="break">{d.error ?? "No error was recorded."}</span>
          {!replayable && <> The payload wasn&apos;t kept, so it can&apos;t be replayed; GitHub can redeliver it from the App&apos;s advanced settings.</>}
        </Alert>
      )}
      <Card title="Outcome" titleId="outcome-heading">
        <dl className="kv">
          <dt>Delivery id</dt>
          <dd className="mono">{d.deliveryId}</dd>
          <dt>Repository</dt>
          <dd>{d.repoId && d.repoFullName ? <Link href={`/dashboard/repos/${d.repoId}`}>{d.repoFullName}</Link> : (d.repoFullName ?? "—")}</dd>
          <dt>Outcome</dt>
          <dd>
            <StatusPill kind="delivery" value={d.status} />
            {d.reason && <span className="dim"> — {d.reason}</span>}
          </dd>
          <dt>Jobs queued</dt>
          <dd>{d.jobs.length ? <ul className="mono" style={{ margin: 0, paddingLeft: "1.1em" }}>{d.jobs.map((j) => <li key={j}>{j}</li>)}</ul> : "None"}</dd>
          <dt>Attempts</dt>
          <dd>{d.attempts}</dd>
          <dt>Received</dt>
          <dd>{formatDate(d.receivedAt)}</dd>
          <dt>Processed</dt>
          <dd>
            {formatDate(d.processedAt)} {d.durationMs !== null && <span className="dim">({formatDuration(d.durationMs)})</span>}
          </dd>
          {d.payloadSha256 && (
            <>
              <dt>Payload SHA-256</dt>
              <dd className="mono break">{d.payloadSha256}</dd>
            </>
          )}
        </dl>
      </Card>
    </>
  );
}
