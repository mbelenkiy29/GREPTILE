# Self-hosting

OpenReview has two parts:
- **Web app:** Next.js. It runs on Vercel, Docker or any Node.js 24 host.
- **Backend:** Convex. Use Convex Cloud, or the open-source Convex backend on your own infrastructure.

Repository files are stored as Convex file blobs. Metadata, symbols, the code graph and embeddings live in Convex tables.

## Checklist

1. Set the core configuration:
   - `APP_URL` identically on the web app and the backend.
   - `SESSION_SECRET` (32+ characters) and `SERVICE_SECRET` on both.
   - `CREDENTIAL_ENCRYPTION_KEY` (32+ characters) on the backend, to encrypt provider and integration credentials. Back it up.
2. Configure a model (`LLM_PROVIDER`, `LLM_API_KEY`) and the inference budget.
3. Register your [GitHub App](github-app.md) or connect another provider.
4. Optionally add:
   - embeddings (`EMBEDDING_MODEL`, `EMBEDDING_API_KEY`).
   - Slack and email ([notifications](../notifications.md)).
   - more sign-in methods ([identity](../identity.md)).
5. Leave `BILLING_ENABLED` unset. [Billing](../billing.md) is for hosted cloud deployments only, and self-hosted installs have no quotas.

## Docker

```sh
docker build -t openreview:local .
```

The [deployment guide](../deployment.md) covers Docker Compose with a self-hosted Convex backend, backups and upgrades.
