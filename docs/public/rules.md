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

## Rule assistant

Admins can ask the configured model for help on the Custom rules page. There are three kinds of request:

- **Draft a rule** from a plain-language description, at the scope you pick.
- **Review existing rules.** The assistant proposes tighter wording for vague rules (words such as "properly" or "best practices" are flagged first) and flags pairs of rules that conflict or duplicate each other. Reusing a title at a narrower scope is a deliberate override and is not flagged.
- **Suggest rules** from two sources: groups of findings that authors fixed on at least two pull requests, and approved learned conventions that no rule covers yet. Each suggestion lists the findings (with the pull requests) or the convention it is based on. It is scoped to the repository or team all of its sources share, and to the workspace otherwise.

Every result is a **suggestion**. Nothing changes until an admin acts on it:

- **Approve** a drafted or suggested rule to create it; you can edit the title, instructions and severity first.
- **Approve** tighter wording to apply it to the existing rule. If someone edited that rule after the suggestion was made, the suggestion closes as out of date instead.
- **Approve** an overlap flag to disable the newer rule of the pair.
- **Dismiss** a suggestion to leave everything as it is.

Model output is checked twice: when it arrives and again when it is approved, including any edits you make. Text that tries to change the reviewer's instructions, suppress or downgrade findings, approve changes, or change budgets and tools is discarded, and so are code blocks, HTML and file globs outside the repository. The run history shows each discarded suggestion and the reason. Each request is one model call, counted against the inference budget and recorded as `rule-assistant` usage. A workspace can have two requests running at once and 30 per day. Requests and decisions are recorded in the audit log.
