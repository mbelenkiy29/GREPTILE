# Hosted external API and agent-context acceptance

October 4, 2026. A bounded external HTTP client exercised the canonical production origin using one temporary API key scoped to the existing acceptance workspace and existing owner. The key was revoked in a finally-protected workflow; backend readback and the portal both confirm Revoked. The raw key stayed in process memory and was not written to evidence.

Passed:
- Unauthenticated repository reads return 401.
- Authorized repository inventory matches the backend's eight accessible repositories.
- Review pagination returns 30 + 16 unique records, with correct workspace/repository boundaries and a terminating cursor.
- Existing GitHub PR #4 review detail and history continuation retain the selected review and do not repeat history rows.
- Agent metadata and a real indexed source file preserve repository, path and SHA identity.
- Another workspace's repository is rejected for context and review requests (403), despite the same owner's membership in both workspaces.
- Malformed review revision is rejected before dispatch (400).
- After revocation, repository reads return 401 and context reads return the existing unauthorized/unavailable 400 response.

No valid review request, inference, agent launch or source indexing occurred. This proves existing-owner compatibility of these live HTTP paths. It does not establish new-user team/viewer restrictions, every provider variant, or every mutation/client.

The code audit also found the public Convex agentContext.get query checked workspace membership without repository team access. It now calls authorizeRepository before reading metadata or generating source URLs. A durable regression proves private-team denial, owner access, authorized viewer reads, immediate denial after team removal, public-repository access and exclusion of another repository's custom rules. The live owner/API walkthrough alone cannot prove multi-user isolation.

Full verification: 170 Node + 138 Convex = 308 tests, lint, typecheck and build. Backend dry-run/actual deploy verified tidy-ocelot-457. No schema/env/frontend change. Evidence: output/setup/external-api-live-evidence.json, external-api-key-revoked-live.png and agent-context-access-{tests,regression,typecheck,lint,build,convex-dry-run,convex-deploy}.log. The pending mobile/dark check still requires an unlocked desktop.
