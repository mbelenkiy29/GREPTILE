# Atlassian requirements integration

The native adapter in `src/atlassian.ts` implements OAuth 3LO authorization/code exchange and rotating refresh tokens, accessible cloud-site discovery, paginated Jira projects and Confluence spaces, and read-only issue/page retrieval. It reads native ADF documents as data and keeps issue updated timestamps and page version numbers with canonical source links. It verifies site access and selected project/space identity before fetching document bodies, then checks resource identity again on the content response.

**Implementation status:** native HTTP and Convex integration checks pass for the adapter, encrypted connection storage, admin-only OAuth callback, resource selection, rotating refresh tokens, scope generation/cache guards, immediate disconnect and review requirements retrieval. Live OAuth, scoped Jira retrieval and a published review citation have passed on the acceptance workspace. On October 3, 2026, its expired credential rotated through the deployed refresh flow, preserving selected resources and scope generation; KAN-1 was fetched again afterward without inference. Live Confluence retrieval and account-level revocation remain unverified. The portal includes setup, selection and recovery controls.

The OpenReview operator must register a distributable OAuth 3LO integration in the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and configure the callback at `/api/integrations/atlassian/callback` on the application origin. Customers should authorize that app; do not ask each customer to create a custom app or collect API tokens. Server-only configuration uses `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`.

Requested scopes: `offline_access`, `read:jira-work`, `read:page:confluence`, `read:space:confluence`. Tokens granting additional permissions are rejected. Resource scopes are checked against the selected site on each read. Jira descriptions are read with the issue's native identity; Confluence uses the v2 page API with `body-format=atlas_doc_format`. This implementation currently accepts standard HTTPS `*.atlassian.net` cloud sites. Custom domains and Data Center are not accepted by this Cloud adapter.

Discovery fails visibly beyond 2,000 projects or spaces and rejects stalled/cross-origin continuation links. API responses are capped at 2MB before parsing and document context at 100KB. Sources are only cited after their native content was fetched; a referenced identifier is not proof of retrieval.

Live acceptance must verify the real admin authorization, encrypted storage, resource scope isolation, token refresh/revocation, disconnect/cache invalidation, and fetched requirements in a real review. Fixtures do not establish an external integration.

Primary API references: [3LO OAuth](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), [Jira projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/), [Jira issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Confluence pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [Confluence spaces](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/).

The selected project and space IDs include their cloud-site ID, preventing collisions across sites. Only explicitly referenced Jira keys and Confluence page URLs from a PR title, description or branch are fetched, with a ten-reference limit per connection and 100KB combined context cap. Retrieval failures and absent references appear in coverage diagnostics. Summary citations must match fetched sources.

Linear and Atlassian share a single 100KB UTF-8 budget in the review requirements context. Documents that do not fit are omitted whole, including their citation provenance; a smaller subsequent document can still fit. Coverage reports the number omitted. Per-provider retrieval ceilings also remain visible.

Disconnect removes encrypted credentials and resource selections immediately, advances the scope generation and invalidates cached context. In-flight refresh cannot restore a disconnected grant; in-flight reads fail authorization validation before their context reaches a review. Atlassian 3LO grant revocation is handled in the authorizing user's [Connected Apps](https://id.atlassian.com/manage-profile/apps). OpenReview exposes that action and does not claim to remotely revoke the grant through an undocumented API. The admin should revoke it there after disconnecting; access and refresh failures remain visible.

## Live resource discovery — October 4, 2026

Computer use on the canonical hosted portal opened the existing acceptance connection's Select resources page. Direct reload and a subsequent client-navigation round trip both returned the same form: the FUNDLANE Jira project is checked, only mbelenkiy29/openreview-acceptance is checked for repository retrieval, and Confluence reports “No authorized Confluence spaces found.” No browser warnings/errors were captured. Initial DOM snapshots were taken before server navigation completed; waiting for the resource heading confirmed normal client navigation rather than a routing defect.

No scope was saved, no connection was disconnected, and no model request or new grant was made. This establishes live discovery and existing-selection presentation, not Confluence page retrieval or grant-revocation recovery. An accessible, authorized Confluence space/page remains necessary for those acceptance steps. Linear still exposes its missing OAuth-client setup state.

Evidence: output/setup/atlassian-resource-discovery-live.png.

## Automatic expiry acceptance and prepared Confluence setup

The actual October 4 expired connection recovered through normal resource discovery/requirements retrieval, preserving generation 2 and the selected Jira project/GitHub repository. KAN-1 was fetched with its native revision and source; an unselected Origin repository received no context. No manual refresh or consent was used. Native 401-triggered recovery and remote-grant revocation remain distinct open cases. [Current evidence](atlassian-auto-refresh-acceptance.md).

Confluence Free signup is prepared for the existing site and requires the pending action-time confirmation for provisioning/terms. No app/space/page is provisioned yet. The earlier missing-product inspection does not establish that Confluence cannot be provisioned.
