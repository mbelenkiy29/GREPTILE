# Changelog

## Unreleased — October 2026

### Setup
- Guided workspace setup: connect a provider, choose repositories, watch the code graph build, then shape the summary, comment scope, triggers and tools with live previews, and invite your team. Automatic reviews wait until you choose when reviews run.
- Installing the GitHub App now works from any signed-in session (email, Google or GitLab) and returns you to setup.

### Monitoring
- Optional error tracking with Sentry and product analytics with PostHog for hosted deployments, off unless configured. Nothing sensitive leaves the browser or server: no session replays, no cookies or request bodies, no clicks or page text on signed-in pages, and secret URL parameters are stripped.

### Billing
- Starter plan: unlimited reviews under a monthly fair-use limit (500 per seat by default).
- When billing is on, guided setup ends with a plan step: add a payment method through Stripe Checkout without being charged before the trial ends, or continue on the trial.
- The 14-day trial now starts with a workspace's first review instead of its creation date.
- Restricted Stripe keys (`rk_…`) are accepted, and Stripe requests pin an API version.

### Site
- Privacy Policy and Terms of Service pages for the hosted service, linked from the footer and the sign-in buttons.
- Cookie consent: analytics starts only after a visitor accepts. Do Not Track and Global Privacy Control count as a refusal, and **Cookie settings** in the footer changes the choice.

### Reviews
- Agentic review engine (opt-in) that follows code across files with read-only tools, under per-mode budgets.
- Tree-sitter code graph with resolved cross-file edges, plus optional chunk-level semantic retrieval.
- Summary comment edited in place: overview, files changed, issues, confidence score and an optional sequence diagram.
- Committable suggestions, multi-line comments, incremental re-reviews that resolve fixed threads, and optional GitHub check runs.
- Review triggers (labels, authors, size limits), strictness presets, and repository configuration as code read from the base branch.

### Learning and memory
- 👍/👎 reactions become feedback. Team conventions are learned from human review comments behind guardrails.
- A Memory page to edit, scope (repository, team or workspace), enable, disable or delete what OpenReview has learned.
- `@openreview fix this`: validated suggestions, with optional fix pull requests on a new branch.

### Design
- New look across the site and dashboard: warm parchment and ink, a single ember accent, Inter with JetBrains Mono for code and metadata, and matching light and dark themes.
- New logo: four lines of code with an ember dot pinned to one of them, with pixel-fitted cuts for the header and favicon, an app icon and a dark-mode-aware tab icon.
- The landing page shows the real dashboard screens: a pull request review with an inline finding, verified evidence, the review summary, chat, agent hand-off and analytics.

### Product surfaces
- Codebase chat with cited answers, a public query/search API with scoped API keys, and a remote MCP endpoint.
- Slack app (notifications, Q&A and `/openreview status`) and verified email notifications.
- Notion requirements context, and a finished Confluence/Jira resource picker.

### Running it as a product
- Optional Stripe billing for hosted deployments (trial, per-seat quotas, past-due grace).
- Sign in with GitHub, GitLab, Google or an email link. Server-side sessions with sign-out everywhere, and email invitations.
- Public documentation at /docs, this changelog and a new landing page.
