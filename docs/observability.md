# Error tracking and analytics (cloud)

The hosted site can report errors to [Sentry](https://sentry.io) and product analytics to [PostHog](https://posthog.com). Both are off unless their public keys are set when the web app is built, so self-hosted installs send nothing to either service.

## What is collected

**Sentry (errors and performance):**
- Collected:
  - Unhandled errors in the browser, Server Components, route handlers, server actions and the edge runtime, with stack traces.
  - 10% of page loads and requests as performance traces (`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`).
  - After sign-in, the internal user ID and workspace ID.
- Not collected: cookies, request or response bodies, query strings, local variables, AI prompts or outputs, emails, or session replays. The SDK sends no IP address; to stop Sentry from recording the connecting IP too, turn on **Prevent Storing of IP Addresses** under Project Settings → Security & Privacy.

**PostHog (product analytics):**
- Collected:
  - Page views across the site.
  - Clicks on public pages (home, docs, changelog).
  - After sign-in, the internal user ID, with the active workspace ID on each event.
- Not collected:
  - Clicks and page text on signed-in pages (dashboard, invitations, fix links); those pages only send page views.
  - Session recordings, which are off.
  - Errors, which go to Sentry only.
- Anonymous visitors get no person profile, and browsers that send Do Not Track are not tracked. Turn on **Discard client IP data** in the PostHog project settings so IP addresses are not stored.

**Cookie consent:** PostHog sets a cookie, so it starts only after a visitor accepts the analytics banner (`app/consent.tsx`, rules in `src/consent.ts`).
- **The choice:** stored in the first-party `openreview_consent` cookie (`granted` or `denied`) for 180 days.
- **Browser signals:** Do Not Track and Global Privacy Control count as a refusal, so those visitors are never asked.
- **Declining later:** stops capture in the page and removes PostHog's cookies and storage.
- **Changing the choice:** **Cookie settings** in the site footer reopens the banner.
- **Self-hosted:** without `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` there is no banner.
- **Sentry:** sets no cookies and is not gated.

**URLs:** before any event leaves the browser or server, each URL keeps only a short allowlist of query parameters (`utm_*`, `ref`, `checkout`, `billing`, `signedout`) and loses its fragment. Invitation tokens, sign-in codes, error messages and repository filters are never sent.

**Same-origin delivery:** events go through this site's own origin, so ad blockers that block Sentry and PostHog domains don't drop them:
- `/lighthouse` → Sentry.
- `/lantern` → PostHog.

The filters live in `src/telemetry.ts` and are tested in `tests/telemetry.test.ts`.

## Setup (operator)

Set these on the **web app** (Vercel → Project → Settings → Environment Variables → Production), then redeploy. `NEXT_PUBLIC_*` values are built into the browser bundle, so a change needs a new build.

| Variable | Value | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | The project's DSN (Sentry → Project Settings → Client Keys) | No (public by design) |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Organization and project slugs, for uploading source maps | No |
| `SENTRY_AUTH_TOKEN` | An organization auth token with the `project:releases` scope (Sentry → Settings → Auth Tokens). Without it, stack traces are minified. | **Yes** |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Optional, `0`–`1` (default `0.1`) | No |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | The project API key, `phc_…` (PostHog → Project settings) | No (public by design) |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://us.i.posthog.com` (default) or `https://eu.i.posthog.com` | No |

**Release builds:** with `SENTRY_AUTH_TOKEN` set, a build uploads source maps and deletes them from the output, so they are never served publicly. Errors are tagged with the Vercel environment (`production` or `preview`) and the commit.

**Backend errors:** Convex functions are not covered by this setup. On a Convex Pro plan, turn on Sentry under Convex dashboard → Settings → Integrations → Exception Reporting with the same DSN. Otherwise, use the Convex dashboard's logs.

## Turning it off

Remove the variables and redeploy. Without `NEXT_PUBLIC_SENTRY_DSN`:
- Sentry isn't initialized anywhere.
- The `/lighthouse` route doesn't exist.

Without `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`:
- PostHog isn't initialized.
- The `/lantern` proxy doesn't exist.
