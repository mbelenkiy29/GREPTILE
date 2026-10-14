# Settings preview and viewer-role acceptance

October 4, 2026. Computer use on the canonical hosted portal verified Settings → Code Review → repository selection. The review preview is labeled as example data. Detailed comment style changes the evidence to a code block; enabling Review score adds its reason; disabling Risk assessment removes that summary section. Test execution and coverage remain visible, with no claim of executed tests. Reload restored concise style, score off and risk on without saving settings.

Settings search for API retained only Developer → API Keys. Following that result opened the real key-management page, whose retained fixture keys are revoked. People navigation exposed the owner row and invitation controls. No API key, invitation or role change was submitted.

The walkthrough found omitted viewer options in both People selectors despite existing backend support. The UI now includes viewer in invitation and member editing, preserving existing viewer selection instead of displaying member. No schema, authorization policy or environment change.

Lint, typecheck and local build pass. The existing backend suite (48 tests) passes, covering viewer invitations, mutation restrictions and last-owner protection. Last full shared suite remains 304 tests. No new implementation-mirroring test was added for two selector options. Hosted deployment and post-release selector verification are recorded in implementation-status.md.

Evidence: output/setup/settings-preview-detailed-live.png and settings-viewer-{lint,typecheck,build,backend-tests,vercel-deploy}.log. Viewer invitation acceptance, actual viewer browser session, responsive/current dark-mode and other remaining settings workflows are not established by this walkthrough. No model or source indexing was invoked.
