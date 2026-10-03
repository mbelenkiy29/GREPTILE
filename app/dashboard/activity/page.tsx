import type { Metadata } from "next";
import { DeliveriesTable } from "@/components/dashboard/DeliveriesTable";
import { FailureFeed } from "@/components/dashboard/FailureFeed";
import { humanize } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Tabs } from "@/components/ui/Tabs";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listFailures, type FailureKind } from "@/lib/data/activity";
import { listDeliveries, type DeliveryStatus } from "@/lib/data/deliveries";
import { deliveryStatus } from "@/lib/db/schema";
import { enumParam, hrefWith, intParam, queryState, type SearchParams } from "@/lib/ui/url";
import { replayDeliveryAction } from "./actions";

export const metadata: Metadata = { title: "Activity" };

const PATH = "/dashboard/activity";
const TABS = ["problems", "deliveries"] as const;
const KINDS = ["delivery", "index", "review"] as const satisfies readonly FailureKind[];

export default async function ActivityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId, role } = await requireOrg();
  const sp = await searchParams;
  const state = queryState(sp);
  const tab = enumParam(sp, "tab", TABS) ?? "problems";
  const admin = can(role, "repos.manage");
  const page = intParam(sp, "page");

  return (
    <>
      <PageHeader title="Activity" description="Webhook deliveries from GitHub and anything that went wrong recently." />
      <Tabs label="Activity views" pathname={PATH} state={state} current={tab} tabs={[
        { id: "problems", label: "What went wrong" },
        { id: "deliveries", label: "Webhook deliveries" },
      ]} />
      {tab === "problems" ? (
        <Problems orgId={orgId} kind={enumParam(sp, "kind", KINDS)} page={page} state={state} admin={admin} />
      ) : (
        <Deliveries orgId={orgId} status={enumParam(sp, "status", deliveryStatus.enumValues)} page={page} state={state} />
      )}
    </>
  );
}

async function Problems({ orgId, kind, page, state, admin }: { orgId: string; kind?: FailureKind; page?: number; state: Record<string, string>; admin: boolean }) {
  const feed = await listFailures(db(), orgId, { kind, page, pageSize: 25 });
  const returnTo = hrefWith(PATH, state);
  return (
    <>
      <form className="filter-bar" action={PATH} aria-label="Filter failures">
        <input type="hidden" name="tab" value="problems" />
        <div className="field">
          <label className="field-label" htmlFor="act-kind">
            Kind
          </label>
          <select id="act-kind" name="kind" className="select" defaultValue={kind ?? ""}>
            <option value="">Everything</option>
            <option value="delivery">Webhook deliveries</option>
            <option value="index">Index runs</option>
            <option value="review">Review runs</option>
          </select>
        </div>
        <div className="filter-bar-actions">
          <button className="button" type="submit">
            Apply
          </button>
        </div>
      </form>
      {feed.items.length ? (
        <>
          <FailureFeed
            items={feed.items}
            action={
              admin
                ? (it) =>
                    it.kind === "delivery" && it.replayable ? (
                      <form action={replayDeliveryAction}>
                        <input type="hidden" name="deliveryId" value={it.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <SubmitButton size="sm" icon="refresh" pendingLabel="Replaying…">
                          Replay
                        </SubmitButton>
                      </form>
                    ) : null
                : undefined
            }
          />
          <Pagination pathname={PATH} state={state} page={feed.page} pageCount={feed.pageCount} total={feed.total} pageSize={feed.pageSize} noun="failures" />
        </>
      ) : (
        <EmptyState icon="check" title="Nothing went wrong recently">
          <p>Failed webhook deliveries, index runs, and review runs show up here with their errors, so you can fix and retry them.</p>
        </EmptyState>
      )}
    </>
  );
}

async function Deliveries({ orgId, status, page, state }: { orgId: string; status?: DeliveryStatus; page?: number; state: Record<string, string> }) {
  const list = await listDeliveries(db(), orgId, { status, page: page ?? 1, pageSize: 25 });
  return (
    <>
      <form className="filter-bar" action={PATH} aria-label="Filter deliveries">
        <input type="hidden" name="tab" value="deliveries" />
        <div className="field">
          <label className="field-label" htmlFor="del-status">
            Outcome
          </label>
          <select id="del-status" name="status" className="select" defaultValue={status ?? ""}>
            <option value="">Any outcome</option>
            {deliveryStatus.enumValues.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-bar-actions">
          <button className="button" type="submit">
            Apply
          </button>
          {status && (
            <ButtonLink href={`${PATH}?tab=deliveries`} variant="ghost">
              Reset
            </ButtonLink>
          )}
        </div>
      </form>
      {list.items.length ? (
        <>
          <DeliveriesTable deliveries={list.items} />
          <Pagination pathname={PATH} state={state} page={list.page} pageCount={Math.max(1, Math.ceil(list.total / list.pageSize))} total={list.total} pageSize={list.pageSize} noun="deliveries" />
        </>
      ) : (
        <EmptyState icon="activity" title={status ? "No deliveries with this outcome" : "No webhook deliveries yet"}>
          <p>Once the GitHub App is installed, every event GitHub sends is recorded here with what OpenReview did about it.</p>
        </EmptyState>
      )}
    </>
  );
}
