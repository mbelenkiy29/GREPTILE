# Custom rules

Rules describe what reviewers on your team always look for. Each rule has:
- **Instructions:** what to check, for example "Every organization API must validate membership".
- **Severity and category.**
- **Globs** that limit the rule to matching paths.
- An **enabled** flag.

Rules can live in three places. Later sources add to earlier ones:

1. **Workspace or team rules,** in Memory → Custom rules.
2. **Repository rules,** in the dashboard.
3. **Repository files,** read from the pull request's base branch:
   - `.openreview.json` (`rules` array).
   - `.openreview/rules.md`: one `## Title` section per rule, optionally starting with `severity:`, `category:` and `globs:` lines.
   - Nested `<dir>/.openreview.json` files, which apply only under that directory.

Because configuration is read from the base branch, a pull request cannot weaken its own review. Admins can lock settings so repository files cannot override them. See [repository configuration](../repo-config.md).

```markdown
## Money is integer cents
severity: high
category: correctness
globs: src/billing/**
Amounts are integer cents everywhere; flag floats or division that produces fractional cents.
```
