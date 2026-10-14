# Contributing

Use Node.js 24 and pnpm 11. Start from the README local quickstart. Keep changes scoped and reuse the shared engine for new SCM/API adapters. Never add static findings or dashboard metrics to production pages.

Before submitting a change run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Run browser checks for dashboard flows and real evaluation when modifying review quality. Document environment/schema changes. A deterministic test demonstrates orchestration invariants; it does not establish model detection accuracy.

Prefer regression tests with actual source evidence and cross-file context. Validate all external payloads, enforce organization authorization in backend functions, and keep repository content untrusted. Never commit credentials, `.env` files, or private repository captures.
