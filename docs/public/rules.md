# Custom rules

Rules describe what reviewers on your team always look for. Each rule has:
- **Instructions:** what to check, for example "Every organization API must validate membership".
- **Severity and category.**
- **Globs** that limit the rule to matching paths.
- An **enabled** flag.

Rules can live in three places. Later sources add to earlier ones:

1. **Dashboard rules,** in Memory → Custom rules, with a scope:
   - the **entire workspace**;
   - one **team** (every repository assigned to the team);
   - **repositories matching a pattern** on the full name, such as `acme/*-service` or `acme/{api,web}`;
   - one **repository**.

   When rules with the same title apply to a repository, the most specific scope wins (repository, then pattern, then team, then workspace), so a team or repository can replace a workspace rule by reusing its title. Rules created before scopes existed keep their meaning. Admins create and edit rules (every change is in the audit log); viewers can read them.
2. **Repository rules** in nested `.openreview/` folders (see below).
3. **Repository files,** read from the pull request's base branch:
   - `.openreview.json` (`rules` array).
   - `.openreview/rules.md`: one `## Title` section per rule, optionally starting with `severity:`, `category:` and `globs:` lines.
   - Nested `<dir>/.openreview/rules.md` and `<dir>/.openreview/config.json` (or legacy `<dir>/.openreview.json`) files, which apply only under that directory.

Because configuration is read from the base branch, a pull request cannot weaken its own review. Admins can lock settings so repository files cannot override them. See [repository configuration](../repo-config.md).

```markdown
## Money is integer cents
severity: high
category: correctness
globs: src/billing/**
Amounts are integer cents everywhere; flag floats or division that produces fractional cents.
```
