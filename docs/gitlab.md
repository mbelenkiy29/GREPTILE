# GitLab setup and acceptance

OpenReview connects GitLab.com and authorized self-managed HTTPS instances through a dedicated bot token. The instance, connection, and external project ID identify each repository. Group and subgroup namespaces create corresponding OpenReview teams; selecting a repository preserves the configured inheritance chain.

## Connect

1. Create a dedicated GitLab account with an expiring `api` token. Grant Developer access to the repositories it must index and review. OpenReview needs repository API reads and merge-request note/discussion writes; it does not need instance administration.
2. For a self-managed instance, add its host (including a non-default port) to `SCM_ALLOWED_HOSTS` in both frontend and Convex environments. Preserve existing entries. HTTPS certificate verification remains enabled.
3. In Settings → Code Providers, choose GitLab Cloud / self-managed, enter the instance URL, bot token and a random webhook secret, then connect. Credentials are encrypted with the operator's `CREDENTIAL_ENCRYPTION_KEY`.
4. Select repositories, enable them, and inspect completed indexing, indexed revision, skipped files and failure/retry controls under Add/Remove Repos.
5. Configure the displayed repository webhook URL in GitLab with the same secret token. Enable merge request, push and comment events, retaining SSL verification. Verify delivery before enabling automatic reviews. See [GitLab's project webhook API](https://docs.gitlab.com/api/project_webhooks/).

Automatic reviews honor effective Automatic review, draft, target-branch, ignored source-branch and Re-review settings. New code pushes are distinguished using GitLab's documented `object_attributes.oldrev`; approval events do not launch reviews. Push events index the default branch. See [GitLab's event payloads](https://docs.gitlab.com/user/project/integrations/webhook_events/).

Follow-up comments require a current active Developer-or-higher author, including inherited group membership. The bot's own comments, edits, internal/system notes, mismatched actors/projects and changed native discussion bodies are rejected. Finding publications bind GitLab base/start/head revisions and the actual added line. Resume uses only bot-owned revision markers to avoid duplicate inline notes and summaries.

## Live self-managed acceptance, 2026-10-03

A disposable private GitLab CE 19.4.1 ARM64 instance was provisioned from the official image, pinned to `sha256:7fff8748a25202c1d38885797510afe055f555856f3f50c2b17466a853be5d24`. Public signup is disabled. The dedicated OpenReview account has inherited Developer access; its credential expires after one day. This instance contains synthetic acceptance source only. It is a test fixture accessed through a temporary HTTPS tunnel, not a production GitLab hosting recommendation.

Verified against the actual hosted app and native GitLab APIs:

- Private repository enumeration and selection, group-to-team association, inherited author write permission and unknown-author denial.
- Initial six-file indexing at `83bf9cfcc43067801102b6a944f13297d1c28f9b`, recorded functions/imports/calls/test relationships, and repeat indexing with zero changed files.
- Native signed-secret push webhook delivery with `202 Accepted`, and completed durable event processing.
- Native merge request creation automatically triggered the shared engine at `b0f7676137cc8e5251fe32df68870302f4edbbfb`. Eight model calls produced one verified cross-file cents regression, while suppressing five other candidates.
- The hosted worker published native inline note 2 at `src/price.ts:3` and summary note 3 as `openreview-bot`. Exact native position/head identity, hosted Fix link and truthful “Not executed by OpenReview” summary were read back. No finding or summary was manually published.
- Computer use verified repository discovery and completed review detail, findings, history, lifecycle, model costs and Fix controls. Browser warnings/errors were empty. This proves rendered controls, not GitLab-specific agent launch.

Evidence is in ignored `output/setup/gitlab`: `connection-evidence.json`, `graph-evidence.json`, `webhook-evidence.json`, `review-evidence.json`, `publication-evidence.json` and `review-portal.png`. Initial knowledge inference cost $0.008310; review inference cost $0.060934. Recorded hosted inference after this check was $1.423248, below the $5 acceptance cap.

Still required: live feedback commands, lost-publication recovery, bridge launch/fix/push for this provider, GitLab.com acceptance, additional native OS/agent combinations and provider-specific approval behavior. GitLab approval is not established by these checks. Do not infer full provider or Greptile parity from this fixture.


## Follow-up and corrected revision acceptance, 2026-10-03

A native Alice question (note 4) in the original finding discussion triggered a durable hosted answer. OpenReview published note 5 in the same discussion, quoting actual unchanged billing source at lines 2–4 with URLs pinned to the original head. Native file reads independently verified the quoted text and coordinates. The answer states that no test execution evidence was supplied. A native resend of webhook event 8 returned 202 and retained the same conversation and bot reply with no additional inference. Answer inference cost $0.009778.

A native REST commit by the synthetic author restored integer cents, isolated display formatting and added regression assertions at `38ecad7666d69d6ab6a78fed70eac9117ba71a94`. This is a provider update/resolution fixture, **not an agent-generated fix or runtime execution check**. Its automatic review exposed a shared engine bug: the resolution model quoted the correct source statement at an incorrect line, and the engine silently discarded the proof while allowing the prose to claim a fix.

The engine now supplies numbered source lines and validates exact coordinates, known unique fingerprints, fetched source identity and execution claims through its model-output validator. Invalid proof triggers bounded model repair rather than silent acceptance. Unconfirmed prior findings add coverage diagnostics, are supplied separately to summary generation, and summaries reject unsupported prior-resolution claims. The regression reproduces the native incorrect-line proof.

After deployment, a real portal Re-review click completed review `mx78944n8fc2qdkdkjem8h8mkh8fkgqc` at the same corrected revision. It verified the return statement at line 3, marked the original finding resolved, and published native summary note 9 with the matching Resolved findings section and truthful unexecuted-test status. Both the native source and publication were read back; computer use verified review history and the rendered resolution, with empty browser warnings/errors.

All 87 Node + 78 Convex tests (165), lint, typecheck and build passed. Vercel production `dpl_jLx3tz9WmCUvqxyfDzibuE7sLAMJ` is READY, and Convex deployment succeeded. The initial corrected review cost $0.074786; the repaired-resolution re-review cost $0.084048. Recorded hosted inference is $1.591860. Evidence: `followup-question.json`, `followup-evidence.json`, `replay-evidence.json`, `resolution-evidence.json` and `resolution-portal.png`. Broader provider, bridge, runtime/approval and OS acceptance remain incomplete.

## Exact revision runtime archives

The GitLab adapter downloads the native gzip archive for an explicit 40-character commit using the connection's external project ID and dedicated credential. Branch names, redirects, unavailable bodies, oversized header or streamed bodies (20 MB compressed), and non-gzip responses fail visibly. LFS blobs are excluded; tests requiring LFS artifacts cannot be established by this archive path. GitLab's archive hotlink detector rejects Node fetch's default CORS fetch mode; the server request explicitly uses same-origin mode and rejects redirects.

Live acceptance fetched both native fixture commits through the authorized HTTPS instance and ran `node --test tests/billing.test.ts` using the existing digest-pinned Docker sandbox: the original defect exited 1 and the corrected revision exited 0. Both recorded actual execution, their exact heads, no network, one CPU and 512 MB memory. This direct archive check made no model calls. Evidence: ignored `output/setup/gitlab/runtime-archive-evidence.json`. Runtime remains disabled by default and requires an approved connected worker; direct checks alone do not establish durable worker integration or automatic approval.

The subsequent hosted durable check passed: provider-native `rereview` created `mx74eydvvr02h6vgznxb7n3k6d8fjvhv`, Convex prepared the exact archive, authenticated worker `qs7ee17tahmr86bm27zvdsar158fj50y` claimed job `qh73x3fkkcyg960ew19ngq63yd8fjc67`, fetched its snapshot, executed two tests and reported exit 0. The hosted review persisted exact-revision evidence, and native bot summary note 10 reports the recorded command as passed. Computer use verified the runtime status, logs and summary with no browser warnings/errors. The temporary worker is revoked, the original repository policy is restored, and approval stayed disabled. This is a local worker against hosted Convex, not continuous hosted worker availability or GitLab approval acceptance.

The initial acceptance helper used the GitHub-compatible `reviews.request` mutation without GitLab's base/start revision key; its run was correctly cancelled before inference. GitLab manual runs must use the provider-native `providerJobs.rereview` action, as the portal does, to obtain current native revision identity. No validation was relaxed to make the helper pass.

All 88 Node + 78 Convex tests (166), lint, typecheck and build passed. Production deployment `dpl_FWdSLmnzLtqMRhRSSf2nbxRhfrGN` is READY and Convex push succeeded. This review cost $0.071764; recorded hosted inference is $1.663624, below the $5 cap. Durable evidence and native publication: `runtime-durable-evidence.json`; browser proof: `runtime-portal.png`.


## Native opt-in approval

GitLab now implements the shared approval snapshot, exact-SHA native approve, bot-owned receipt replay and scoped unapprove. Controls appear under Runtime & Approval for active GitLab connections; approval remains disabled by default. Native project pipeline/discussion requirements, current merge conditions and any required external status services join the trusted OpenReview checks. Missing, pending, failed, stale, ambiguous and unsupported responses block verification. Latest commit statuses are bound to the reviewed head and source branch; GitHub App IDs cannot be satisfied by GitLab jobs. MR lifecycle and approval/unapproval events schedule current approval rechecks; the existing durable sweep remains a fallback.

GitLab exposes current approvals rather than immutable review IDs. An OpenReview receipt note records its exact head, base/start tuple and native bot approval timestamp. Its ID is a receipt ID, not a GitLab approval ID. Only the intact bot-owned receipt plus matching native approval can satisfy replay. Unapprove removes only the authenticated bot; OpenReview never resets all approvers or merges. Old receipts cannot withdraw a newer timestamp. Versions omitting native timestamps fail visibly, and a lost approve response without a receipt requires inspecting/removing the bot approval before retrying. Known approval followed by failed receipt publication is withdrawn while its timestamp still matches. Re-review creates a fresh job after recovery.

Live GitLab CE 19.4.1 native API acceptance created disposable documentation MR !2 at 51fd54660f7c81f575ec19697866923af8a2a0b9. Exact-head approval, native receipt 12, readback, duplicate replay and idempotent withdrawal passed; cleanup confirmed zero bot approvals and no merge. This native adapter test did not exercise model confidence or automatic policy gates. Its real webhook independently triggered one completed OpenReview review, mx7dvjdtdd4ky5ym7x8pazfaw18fke3r, with zero findings, complete recorded coverage, low risk and 90% model confidence. No duplicate re-review was requested.

The separate hosted durable approval test temporarily enabled a repository policy, evaluated that actual completed review and correctly blocked job qx71pxn02mcv61j21xdkw8vrg18fjww3 on maximum confidence. The original policy was restored and no native bot approval remained. Computer use verified the deployed blocked status/reason and 90% assessment, with no browser warnings/errors; screenshot approval-portal.png. Native adapter publication is proven; positive model-to-automatic-approval acceptance, live objection/required-check transitions, licensed external checks, GitLab.com and the wider OS/provider matrix remain pending. No model assessment or gate was weakened.

All 101 Node + 81 Convex tests (182), lint, typecheck and production build pass. Deployed Convex and Vercel dpl_G3u3n8ZH3ddSBFboQ86fWexur2rv READY. Recorded hosted inference $1.725116, below the $5 cap; MR !2's automatic review added $0.038878. Evidence: approval-snapshot-evidence.json, approval-native-evidence.json, approval-durable-evidence.json and approval-portal.png under ignored output/setup/gitlab.
