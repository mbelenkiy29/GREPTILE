# Production readiness checklist

The operator runs these steps. They change hosted accounts or need secret values, so the automated parity work only prepares them. Run them in order and tick each one off. Commands that print secret values are marked; run those only in a private terminal, never in a shared log, ticket or chat.

Current hosted setup (see [deployment.md](deployment.md)):
- **Web:** Vercel project `openreview`, team `open-review-free`, served at the canonical alias.
- **Backend:** Convex deployment `tidy-ocelot-457`.
- **Build:** the production build runs `convex deploy` (see `vercel.json`).

## 1. Make production reachable (Vercel Deployment Protection)

At audit time production sat behind Vercel Deployment Protection, so outside users, the GitHub OAuth callback and the installation setup redirect were blocked.

1. Open the Vercel dashboard, select project **openreview**, then go to **Settings → Deployment Protection**.
2. Choose one of these:
   - **Option A (no custom domain):** set the scope to **Standard Protection**. This protects every deployment except production domains, so the production domain becomes public while previews and generated deployment URLs stay protected.
   - **Option B (custom domain):** add a domain under **Settings → Domains**, assign it to Production, keep **Standard Protection**, and then use the custom domain everywhere below as `<web-origin>`.
3. Do not use **All Deployments** for production: it blocks OAuth callbacks.
4. Do not hand out Protection Bypass for Automation secrets to work around this; bypass tokens are credentials.
5. Verify from a signed-out browser or `curl -I https://<web-origin>/api/health`: you should get HTTP 200 and no Vercel login page.

Reference: https://vercel.com/docs/deployment-protection

## 2. Align URLs (`APP_URL`, GitHub App)

1. In Vercel → **Settings → Environment Variables** (Production), set `APP_URL` to the exact `<web-origin>` (HTTPS, no trailing slash).
2. Set the same `APP_URL` in the Convex production environment (Convex dashboard → deployment → **Settings → Environment Variables**).
3. In GitHub → **Settings → Developer settings → GitHub Apps → (your app) → General**, set:
   - **Callback URL:** `https://<web-origin>/api/auth/callback`
   - **Setup URL:** `https://<web-origin>/api/github/callback`
   - **Webhook URL:** `https://tidy-ocelot-457.convex.site/github/webhook`. This must be the production Convex `.convex.site` origin, not a tunnel.
   - **Webhook secret:** unchanged, and equal to Convex `GITHUB_WEBHOOK_SECRET`.
4. Redeploy production (`vercel --prod`) after changing variables.
5. Then verify:
   - Sign in through GitHub.
   - Under **Advanced → Recent Deliveries** of the App, confirm a `ping` or `pull_request` delivery returns 2xx.

## 3. Confirm environment variable names (not values)

**Vercel (Production).** `vercel env ls production` lists names only. Required:
- `APP_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`
- `SESSION_SECRET`, `SERVICE_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`
- `CREDENTIAL_ENCRYPTION_KEY`
- `CONVEX_DEPLOY_KEY`, provided by the Convex integration. Never prefix it with `NEXT_PUBLIC_`.

**Convex (production).** Check in the dashboard (**Settings → Environment Variables**), where you can read names without revealing values. `npx convex env list --prod` **prints values**; run it only privately, if at all. Required:
- `APP_URL`
- `SESSION_SECRET` and `SERVICE_SECRET`, identical to Vercel's
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY`, identical to Vercel's
- `LLM_PROVIDER`, `LLM_API_KEY` and, optionally, `LLM_MODEL`
- Optional:
  - `LLM_MODEL_<TASK>`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_STRUCTURED_OUTPUT`, `INFERENCE_PRICES`
  - `EMBEDDING_*`
  - `SCM_ALLOWED_HOSTS`
  - `LINEAR_CLIENT_ID`, `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`
  - `ORIGIN_*`, `BITBUCKET_FORGE_*`

Compare against [.env.example](../.env.example). Every name in it is documented there.

## 4. Replace the model API key before 2026-11-01

The configured model key expires on **2026-11-01**.

1. Create a new key with the provider (OpenAI or Anthropic) and restrict it to this project if the provider supports that.
2. Set it in Convex production as `LLM_API_KEY`, using the dashboard or `npx convex env set LLM_API_KEY --prod` (which prompts or reads the value; don't paste it into shell history).
3. To move to Claude, also set `LLM_PROVIDER=anthropic` and leave `LLM_MODEL` empty for the defaults: `claude-sonnet-5-5` for review, verify and conversation, and `claude-haiku-5-5` for summary and knowledge. If an inference budget is active, these models have built-in verified prices.
4. Update the local `.env.local` / `.env.backend` the same way for development.
5. Revoke the old key after the next review completes with the new one.

## 5. Inference budget

The durable inference budget (see [inference-budget-reconciliation.md](inference-budget-reconciliation.md)) had about $0.12 of $5 unreserved at audit time, so reviews will soon be refused.

1. Decide on a new limit.
2. Re-initializing an existing budget is refused by design, so record a reconciliation as that document describes rather than resetting spending.
3. Models without a built-in or `INFERENCE_PRICES` entry are refused while a budget is active.

## 6. Backups

- Convex Free/Starter keeps up to two manual backups per deployment, each kept for 7 days. Scheduled daily or weekly backups require Convex Pro.
- Before any migration or schema-affecting release, open the Convex dashboard → **Backups → Backup Now**, with file storage included.
- For an off-platform copy, run `npx convex export --prod --include-file-storage --path <private-dir>`. The ZIP contains user data and encrypted credentials, so store it encrypted and outside the repository.
- Backups exclude code, environment variables and pending scheduled functions. Keep an off-repo record of environment variable names (§3) and of where the secrets are stored.
- Restoring replaces table data, so always back up first.

Reference: https://docs.convex.dev/database/backup-restore

## 7. Final verification

1. Check that `https://<web-origin>/api/health` and `https://tidy-ocelot-457.convex.site/health` both report ok.
2. Sign in as a non-team GitHub user to confirm public sign-in works.
3. Install the App on a test repository, enable it, and wait for indexing to complete.
4. Open a small PR. Confirm a review is posted and the dashboard shows the review and its model-call costs.
5. Record the evidence in [acceptance-matrix.md](acceptance-matrix.md). A health check alone does not prove the review loop.
