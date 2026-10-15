# Linear requirements context

OpenReview uses Linear's native OAuth and GraphQL APIs with **read** scope and S256 PKCE. No Linear SDK or write permission is required. Workspace owners/admins connect and configure access in **Memory → Integrations**; members and viewers cannot change connections or retrieve the resource inventory.

## Setup

1. Create an OAuth application in the Linear workspace you administer. Register `https://<openreview-origin>/api/integrations/linear/callback` (or the displayed localhost callback for development). Configure read-only access and PKCE.
2. Set `LINEAR_CLIENT_ID` on both the Next.js server and Convex backend. Set matching `APP_URL` origins. Credentials use the existing `CREDENTIAL_ENCRYPTION_KEY`; preserve this server-only key in your encrypted operator backup.
3. Click **Connect Linear workspace** and approve the read-only grant in Linear. OAuth state is encrypted, bound to the signed-in admin and OpenReview workspace, expires after ten minutes, and is consumed once.
4. Select Linear teams, optional projects, and allowed repositories. No team/repository selection means no retrieval. An empty project selection permits all projects and issues without projects within selected teams. Selecting projects restricts issues to those projects.
5. Reference an issue identifier such as `ENG-42` in a PR title, description, or branch. Reviews fetch the current issue only after checking its native workspace, team and project identities; those identities are checked again when fetching its body. Evidence retains the native source URL and update timestamp. Requirements text is untrusted context and cannot authorize actions.

Access tokens expire and refresh tokens rotate. Admins can retry renewal with Refresh Linear connection in the portal; success and retry/reconnect failure guidance are explicit. Refresh uses a transactional lease; overlapping refresh requests fail visibly for retry. Disconnect immediately erases the active credential and resource bindings, increments the authorization generation, invalidates model caches, and schedules native revocation. Revocation has a two-minute recovery lease and three bounded attempts; temporary encrypted job credentials are erased on success or exhaustion. A final failure tells the admin to revoke OpenReview in Linear settings. Reconnection waits for pending revocation to finish.

In-flight retrieval, cache reads/writes, review persistence and the pre-publication check verify the selected connection generation. A scope change or disconnect stops stale context from being published. Already published reviews remain historical records. Native publication and a local disconnect cannot be one transaction; a scope change after the final check can overlap an already-sent provider request.

## Coverage and verification

Resource discovery permits 2,000 teams/projects each and fails visibly on incomplete pagination. A repository may select five Linear workspaces. Each review fetches at most ten distinct referenced identifiers and 100KB of requirements, within the shared retrieval budget. Missing/inaccessible/out-of-scope issues, identifier and byte limits, and omitted/truncated external context appear in review diagnostics. OpenReview does not fetch unrelated issues or silently fall back to stale issue descriptions. Generated Linear citations must match an actually fetched source URL.

Runnable checks cover native OAuth/PKCE, token rotation/revocation, pagination, GraphQL partial failures, issue scope/movement, tenant/admin/viewer restrictions, replay, refresh/revocation leases, cache invalidation, in-flight scope changes, and requirements-to-finding provenance. These checks use native API contracts and controlled fixtures. **A private OAuth application is now registered and its client ID is configured on both hosts. Read-only workspace consent, token exchange, discovery, selected scope and direct live requirements retrieval now pass. Native manual refresh/rotation and post-refresh retrieval now pass ([evidence](internal/linear-refresh-acceptance.md)); native disconnect/revocation and old receipt/cache-read rejection now pass ([evidence](internal/linear-revocation-acceptance.md)); reconnection consent and published PR-context acceptance remain pending.**

Computer use verified the unconfigured setup and expired-authorization recovery screens with no browser errors. The 390px mobile page has no document overflow after fixing callback URL wrapping; the resource picker and successful OAuth flow still need live-account acceptance.

Primary API references: [OAuth](https://linear.app/developers/oauth-2-0-authentication), [GraphQL](https://linear.app/developers/graphql), [pagination](https://linear.app/developers/pagination).

## Domain change — October 15, 2026

Production moved to https://openreview.tech, and the OAuth callback is built from `APP_URL`. The Linear OAuth application must list `https://openreview.tech/api/integrations/linear/callback`, alongside or instead of the old `openreview-flame-two.vercel.app` callback. Until it does, the provider rejects the redirect when someone connects.

## Hosted registration preparation — October 4, 2026

Computer use found the signed-in **Michael Belenkiy** workspace (`michael-belenkiy`) and its **MIC** team. The prior statement that no real workspace was available is superseded. Its API settings had no OAuth applications. A private **OpenReview** application form is prepared with the sole callback `https://openreview-flame-two.vercel.app/api/integrations/linear/callback`; public installation, client-credentials grants and webhooks are unchecked. This paragraph records the earlier prepared form; the registration state below supersedes its pending-creation status.

Vercel CLI marketplace discovery for `productivity` returned no products, so registration uses Linear's native developer settings. The deployed integration uses S256 PKCE and needs only the public client ID, set on both Next.js and Convex. After registration and deployment, read-only consent, selected-team/repository retrieval, refresh, revocation and a published citation still require live verification. This preparation makes no live integration acceptance claim and consumed no inference.

Evidence: `output/setup/linear-oauth-registration-prepared.png` (private ignored operator artifact; no credentials present).

The current missing-client setup and saved Atlassian resource picker now also have 390px mobile and native CSS dark-mode browser evidence; see [responsive acceptance](internal/integrations-responsive-acceptance.md). This does not establish a successful Linear consent or resource picker.

## Hosted client configuration and native consent — October 4, 2026

On resumption, the live Linear tab had moved to the existing OpenReview application details (`6c066c29-3904-4041-99a8-cdf9058d96df`); no Create action was performed by the agent in this turn. Narrow native reads verified the public client ID, sole hosted callback and **Private to this workspace** availability. No client secret was read, copied or rotated. The public client ID was configured as `LINEAR_CLIENT_ID` in Vercel production and Convex `tidy-ocelot-457`.

Release `dpl_6qFFj4C3nBiYZYgxaU1tyYRKivXD` completed its hosted production build and is READY at https://openreview-flame-two.vercel.app. The hosted Integrations page now exposes Connect Linear workspace. Clicking it reached native Linear consent for the **Michael Belenkiy** workspace, displaying only **Read access to your workspace**. The native consent was initially preserved for action-time confirmation. The user then approved the read-only connection; Authorize completed token exchange and returned to the real resource picker. The successful connection state below supersedes the earlier pending-consent state.

This registration/deployment evidence is supplemented by the successful live connection and retrieval recorded below; it does not prove refresh/revocation or published citations. No inference was requested. Evidence: `output/setup/linear-client-hosted-deploy.log` and `linear-read-consent-prepared.png`. The old missing-client screen is historical, not current production state.

## Live read-only connection and retrieval

After explicit user approval, native consent completed and OpenReview displayed **Michael Belenkiy · Linear — Connected**. Real API discovery returned MIC and SEN teams plus four projects. The saved resource scope selects only MIC (`bfc9ec70-5c0f-4515-a13b-a8d2f3ef3f9a`) and GitHub acceptance repository `m97ecnwd3d1y88k0r038ps0j858fhkp7`; SEN, every other repository and all optional project restrictions are unchecked. Empty project restriction permits projectless issues and all projects within the selected MIC team. Browser success/readback and reload preserved these choices, with empty warning/error logs.

Connection `r57dwvbd99f6hr8fywvd0m7ywx8fmgyn` is active at generation 2, bound to native workspace `c9c6aa42-eb30-4ad1-b38b-7e3db7c14efd`. A redacted durable query confirmed the selected IDs, expiry and stored-credential presence without printing credentials. Source uses the existing encryption boundary; no client secret was needed for S256 PKCE.

Computer use navigated MIC's existing benign onboarding issue **MIC-1: Get familiar with Linear** and read its native title and description. The deployed `integrationJobs:requirements` action then fetched that explicitly supplied identifier for the selected GitHub repository: one 1,591-byte source, update revision `2026-09-07T18:23:46.048Z`, URL `https://linear.app/michael-belenkiy/issue/MIC-1/get-familiar-with-linear`, SHA-256 `259a6fe4f7d7b89da92305d3fa87dd013b10e837fa6cae0df34be7033075ad9c`. Title and Welcome to Linear description match the native UI. The combined Atlassian adapter explicitly omitted MIC-1 because it was outside its selected Jira resources; it did not fabricate a Jira source.

The same reference supplied for the unselected Origin acceptance repository returned zero files and scopes. A selected-repository request without an issue identifier returned zero files and explicit no-reference coverage diagnostics. These are real deployed retrieval calls using native OAuth, not synthetic GraphQL fixtures; they are direct operator acceptance invocations, not a new PR review or published citation. No issue was created/edited and no inference was requested.

Evidence: `output/setup/linear-connected-scope-live.png`, `linear-live-scope-receipt.json`, `linear-native-requirements-live.json`, `linear-unselected-repository-live.json`, `linear-unreferenced-live.json`. Native manual refresh/rotation and post-refresh retrieval now pass ([evidence](internal/linear-refresh-acceptance.md)). Native local disconnect, token denial and stale receipt/cache-read rejection now pass ([evidence](internal/linear-revocation-acceptance.md)); the connection is currently disconnected pending restoration consent. Remaining native acceptance: automatic expiry/401 recovery, remote user revocation and in-flight recovery, issue team/project changes and a published review citing relevant fetched requirements. These requests do not establish the complete acceptance matrix.
