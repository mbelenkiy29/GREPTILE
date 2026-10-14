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

## Precedence

Workspace defaults → team → repository dashboard settings → repository file.

Administrators can **lock** keys at any of those levels under "Lock against the repository config file". A locked key keeps its dashboard value; the review's Coverage section and the repository settings page note that the file value was ignored. Trigger, branch, author and size settings are dashboard-only, because they decide whether a review runs before any file is read.

## Validation

Every file is validated with the schema above (unknown keys are rejected) and limited to 64 KB. An invalid file is ignored. A warning appears in the review summary's Coverage section and on the repository settings page, and the review still runs with the other settings.

The repository settings page shows the effective value of each configurable key and where it came from (default, workspace, team, repository, or repository file), along with the files read from the latest reviewed base revision.
