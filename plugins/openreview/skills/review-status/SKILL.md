---
name: review-status
description: Show the OpenReview review status of a pull request and its open findings. Use when asked whether a pull request was reviewed, what OpenReview found, or what is left to fix.
---

Use the `openreview` MCP tools.

1. Find the pull request number (from the user, `gh pr view --json number`, or ask) and its `repositoryId` with `list_repositories`.
2. Call `get_review_status`. Report the status, the verdict, whether the review covers the latest commit, and how many findings are open.
3. If findings are open, call `list_unresolved_comments` and list them by priority with `file:line`, the title and the suggested fix.
