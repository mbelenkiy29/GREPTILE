# Live-verification runbooks

These runbooks are for a human operator to verify OpenReview against real providers and services. Automated tests cover these paths only with fakes. Each runbook lists prerequisites, exact steps, the evidence to record and the cleanup.

Rules for every run:
- Use disposable repositories and test accounts.
- Never paste secrets into issues, logs or screenshots.
- Live inference costs money: confirm the inference budget before running a review.

Record each outcome, with its evidence level, in [the acceptance matrix](../acceptance-matrix.md).

| Runbook | Covers |
| --- | --- |
| [GitHub Enterprise](github-enterprise.md) | GHES and GHE.com app installation, reviews, checks, follow-ups |
| [GitLab.com](gitlab-com.md) | GitLab.com connection, reviews, suggestions, emoji reactions |
| [Bitbucket Cloud (Forge)](bitbucket-cloud-forge.md) | Forge app registration, deployment, installation and reviews |
| [Bitbucket Data Center](bitbucket-data-center.md) | Data Center connection, reviews and follow-ups |
| [Azure DevOps](azure-devops.md) | Azure Repos connection, service hooks, threads and statuses |
| [Origin fix loop](origin-fix-loop.md) | Origin review → Fix with agent → human push → re-review |
| [Parity features](parity-features.md) | Every Phase B–D capability (suggestions → Notion) |
