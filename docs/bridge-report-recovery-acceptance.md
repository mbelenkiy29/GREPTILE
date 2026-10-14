# Bridge launch reporting recovery

October 4, 2026. Production release `dpl_HoXy8ZUiaLLFsMmZXk4Ws7c9VYbk` is verified READY at https://openreview-flame-two.vercel.app; its integrated build deployed Convex tidy-ocelot-457 and the frontend successfully.

A failed launch-status HTTP report previously exited bridge dispatch after the agent had started, detached its completion tracking and attempted to record a false agent failure. A failed completion report likewise attempted to mark an agent that exited successfully as failed.

Dispatch now keeps tracking the child process after a launch-report failure, warns the user to keep the terminal open and avoid another Fix request, and retries the launch report before reporting successful completion. Authenticated repeated reports of the already-recorded status are idempotent: device/request binding is checked first, and timestamps/state are preserved. This does not permit request-claim replay, skipped launch transitions or contradictory terminal reports. A successful process with an unconfirmed server status produces an explicit reporting error without a false agent-failure report. Real nonzero exits still report failure. Process completion never resolves findings or establishes regression-test success.

The portal's claimed-state message now says it is waiting for launch confirmation and directs users to check the local terminal before retrying. Existing installed bridges need the updated CLI source to receive the local recovery behavior. The isolated Linux acceptance package received the updated bridge source; no pairing or agent configuration changed.

The regression failed before the correction. Subprocess fixtures now prove that a rejected first launch report still waits for the child to complete, attempts launched/ launched/ finished, and succeeds; a rejected finished report yields an explicit successful-process/unconfirmed-status error and never sends failed. These use a fake Node process adapter, not a coding agent. Backend tests verify duplicate launched/finished reports preserve the exact record and retain strict authorization and transition checks.

192 Node + 158 Convex = **350 passing tests**, lint, frontend/backend typechecks and local production build passed. The hosted production build also passed. A read-only computer-use walkthrough verified the authenticated Origin PR #1 Fix All landing page, reviewed revision, all three agent choices and setup/latest-review links; browser warning/error logs were empty. No Fix request was created and no agent was launched. The screenshot proves normal landing-page rendering, not a live outage or claimed-state recovery. Full native OS/agent and live fault acceptance remain incomplete.

Inference ledger stayed at $4.606786 committed and $0.270556 retained reservations under the $5 limit. No inference, credentials, policy changes or repository push occurred for this correction.

Artifacts under `output/setup/`: `bridge-report-red.log`, `bridge-report-green.log`, `bridge-report-backend.log`, `bridge-report-regression.log`, `bridge-report-lint.log`, `bridge-report-types.log`, `bridge-report-backend-types.log`, `bridge-report-build.log`, `bridge-report-vercel-deploy.log`, `bridge-report-deployment.json`, `bridge-report-budget-receipt.json`, and `bridge-report-live-landing.png`.
