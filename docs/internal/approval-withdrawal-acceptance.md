# Approval verification failures and durable withdrawal

The shared approval coordinator previously recorded a failed job when a native approval succeeded but the subsequent native/database verification threw. That could leave its native approval active until a later provider recheck. Approval publication now persists the returned native receipt before post-publication reads. Any later verification error immediately attempts withdrawal.

An unconfirmed withdrawal retains `revocation_pending` with its original native receipt and visible reasons. Its next attempt withdraws rather than re-approves, even when checks and trusted policy pass again. Publication response loss can recover a receipt only by exact job marker, bot identity and reviewed head. Unavailable or ambiguous receipt reads remain pending; a successful authoritative read showing no active owned approval completes invalidation. Legacy failed jobs with native receipts also withdraw on retry. Existing provider adapters retain their ownership/revision/timestamp protections.

The five-minute sweep now schedules bounded 100-job cursor pages for approved, pending, failed, waiting-check, evaluating and pending-withdrawal statuses. Live leases remain protected. Pending withdrawal survives failures to retrieve source/provider authority. New approvals and merges are not initiated by withdrawal recovery. No schema migration, changed opt-in defaults or new environment variable is required.

The portal displays that the native approval may still be active while withdrawal is pending and refreshes active approval states. Revoked permissions, provider outages or ambiguous native receipts can prevent withdrawal; the job remains visible and retriable rather than claiming success.

## Verification

The full suite passes **164 Node + 132 Convex = 296 tests**. Five new durable regressions prove:

- A post-publication verification failure sees the already-persisted receipt and withdraws it immediately.
- Withdrawal failure retains native approval/intent; a live withdrawal lease rejects competing claims, then an expired lease retries withdrawal without another approval.
- A response lost after the native write with unavailable receipt discovery remains pending. Recovery withdraws the exact bot/job/head approval and preserves a human approval.
- Recovery reaches expired pending withdrawal behind 1,000 live leases, through actual scheduled pagination; only expired work is processed.
- Legacy failed jobs containing native receipt IDs withdraw rather than treating recovered gates as approval permission.

Lint, typecheck and local production build pass. Logs: `output/setup/approval-withdrawal-{tests,regression,lint,typecheck,build,vercel-deploy}.log`.

The read-only hosted inventory before deployment contains six jobs: four blocked and two invalidated, zero failed jobs with native receipts. Thus this increment does **not** claim live failed-withdrawal acceptance or manufacture a native approval to do so. Production entry-point readback and deployment identity are recorded separately after deployment. No new model calls were requested. Full live provider approval/revocation and browser/mobile acceptance remain incomplete. The Mac lock prevents the outstanding mobile check; goal remains active.

Production verification: READY `dpl_H36rc5GUTYskJdSDyvRiwt85C8Uk`, canonical https://openreview-flame-two.vercel.app. The deployed `approvals:sweepStatus` entry point ran for an empty pending-withdrawal queue. Job counts/states remained four blocked and two invalidated. Frontend and backend health both return HTTP 200 / ok. Receipts: `approval-withdrawal-{before,after}-evidence.json` and `approval-withdrawal-vercel-inspect.log`. Browser DOM readback and desktop capture of an existing Gitea review show its actual disabled-policy and 98%-confidence blockers with no console errors; `approval-withdrawal-hosted-{review,diagnostics}.png`. This does not exercise the new pending-withdrawal message against a real native failure. Final mobile acceptance remains blocked by the locked Mac.
