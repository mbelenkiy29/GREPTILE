## What and why

<!-- What this changes and why. Reference spec feature IDs (docs/OPENREVIEW_SPEC.md), e.g. R6.12. -->

Feature IDs:

## How it was tested

<!-- New or changed tests (feature tests' titles start with the ID), and anything verified by hand. -->

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass

## Checklist

- [ ] New environment variables are in `lib/env.ts`, `.env.example`, and `docs/configuration.md`
- [ ] Schema changes come with a generated migration (`pnpm db:generate`) and are documented in `docs/DATABASE.md`
- [ ] Tenant-owned data carries `org_id` and every query is scoped by it
- [ ] Model calls go through `lib/llm`; repository and pull request content is delimited as data in prompts
- [ ] Docs describing the changed behavior are updated
- [ ] No secrets, live keys, or third-party brand assets in code, tests, or docs
