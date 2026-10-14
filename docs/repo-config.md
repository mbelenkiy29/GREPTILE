# Repository configuration as code

OpenReview reads review configuration from the repository. Server reviews always read it from the pull request's **base** revision, so a change cannot disable or weaken its own review. The CLI reads it from the base commit of the reviewed range.

## Files

| File | Purpose |
| --- | --- |
| `.openreview.json` | `settings` and `rules` (schema below) |
| `.openreview/config.json` | Same schema; applied after `.openreview.json` |
| `.openreview/rules.md` | Markdown rules: one `## Title` per rule, optional `severity:`, `category:` and `globs:` lines, then the instructions |
| `<dir>/.openreview.json` (nested) | Rules scoped to `<dir>/` (globs are prefixed; no globs means `<dir>/**`) plus scoped `settings.instructions`; other nested settings are ignored with a warning |

```json
{
  "settings": {
    "mode": "deep",
    "minimumConfidence": 0.8,
    "severityThreshold": "medium",
    "maxComments": 10,
    "categories": ["correctness", "security", "data"],
    "ignoredPaths": ["generated/**"],
    "instructions": "Amounts are integer cents.",
    "commentStyle": "concise",
    "summarySections": ["overview", "affectedAreas", "findings", "score"],
    "strictness": 2,
    "reviewEngine": "pipeline"
  },
  "rules": [
    { "id": "cents", "instructions": "Never divide cents by 100.", "severity": "high", "category": "correctness", "globs": ["src/billing/**"], "enabled": true }
  ]
}
```

## API guidance packs

Markdown files in `.openreview/guides/` (at most 10, 16 KB each, read from the base branch like the other config files) add review guidance for third-party APIs. A pack loads when a changed file imports one of its packages or an added line calls one of its functions:

```markdown
---
id: acme-gateway
version: 2
title: ACME payment gateway
imports: @acme/gateway, acme_gateway
calls: chargeCard
---
- Gateway calls must pass the merchant id from the request context.
- Link to the vendor's documentation for each claim.
```

OpenReview ships built-in packs for webhook signature verification, idempotency keys and SDK retries and timeouts. A repository pack with the same `id` replaces the built-in one. Packs only add guidance: they can never suppress, downgrade or approve a finding. A pack that tries to (or that contains prompt-injection phrasing, budget changes, code blocks or HTML) is not used, and the review's coverage notes say why. Reviews list the packs they applied in the summary's Coverage section.

## Precedence

Workspace defaults → team → repository dashboard settings → repository file.

Administrators can **lock** keys at any of those levels under "Lock against the repository config file". A locked key keeps its dashboard value; the review's Coverage section and the repository settings page note that the file value was ignored. Trigger, branch, author and size settings are dashboard-only, because they decide whether a review runs before any file is read.

## Validation

Every file is validated with the schema above (unknown keys are rejected) and limited to 64 KB. An invalid file is ignored. A warning appears in the review summary's Coverage section and on the repository settings page, and the review still runs with the other settings.

The repository settings page shows the effective value of each configurable key and where it came from (default, workspace, team, repository, or repository file), along with the files read from the latest reviewed base revision.
