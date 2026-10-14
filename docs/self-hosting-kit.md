# Self-hosting kit

OpenReview runs as two services: the Next.js web app (this repository's `Dockerfile`) and the
open-source Convex backend, which holds the data, the job scheduler, file storage and the review
actions. [deployment.md](deployment.md) covers Docker Compose on one host. This kit adds:

- a Helm chart for Kubernetes (`deploy/helm/openreview`),
- a Terraform module for AWS ECS Fargate (`deploy/terraform/aws`),
- an offline mode, `OPENREVIEW_OFFLINE=true`, that limits outbound traffic to the hosts you configure,
- a bundled, checksummed set of tree-sitter grammars.

Neither the chart nor the module has been applied to a real cluster or AWS account yet. Run the
checks under [Verify](#verify) before you rely on them.

## Kubernetes (Helm)

The chart deploys:

- the web app as a `Deployment` (two replicas by default, probes on `/api/health`),
- the Convex backend as a single-replica `StatefulSet` with a persistent volume. Convex keeps its data
  directory on that volume, and it must have exactly one writer.
- `Service`s for both, and an optional `Ingress` with three hosts: the web app, the Convex functions
  origin (port 3210) and the Convex HTTP-actions origin (port 3211, which receives webhooks).

Steps:

1. Build and push the web image from this repository:
   `docker build -t <registry>/openreview:<tag> .` then `docker push <registry>/openreview:<tag>`.
2. Create the secret. It holds the web keys listed in `values.yaml` under `secrets.webKeys`, plus
   `CONVEX_INSTANCE_SECRET`, which only the backend reads. Generate each value as 32 random bytes:
   `kubectl create secret generic openreview-secrets --from-env-file=<file>`. Keep the file out of Git.
3. Write a values file with your hosts, image and `secrets.existingSecret: openreview-secrets`, then
   install the chart: `helm install review deploy/helm/openreview -f my-values.yaml`.
4. Generate the Convex admin key:
   `kubectl exec statefulset/review-openreview-backend -- ./generate_admin_key.sh`.
   Store it as an operator credential. It must never reach a browser or an MCP client.
5. Deploy the functions from a checkout:
   `CONVEX_SELF_HOSTED_URL=https://<functions host> CONVEX_SELF_HOSTED_ADMIN_KEY=<key> pnpm exec convex deploy`.
6. Set the backend environment with `pnpm exec convex env set` (same URL and key). This includes the
   secrets, the `LLM_*` settings, `OPENREVIEW_OFFLINE` and `OPENREVIEW_GRAMMARS_DIR`. Convex functions
   read their environment from the deployment, not from the container.

Back up the backend volume with your storage provider's snapshots, and rehearse a restore. To upgrade
the backend, change `backend.image.digest` only after you have read the upstream release notes.

## AWS (Terraform)

The module creates:

- a VPC with two public and two private subnets and one NAT gateway,
- an Application Load Balancer that redirects HTTP to HTTPS (TLS 1.3 policy, your ACM certificate) and
  routes each host to its own target group,
- an ECS cluster with a web service (`web_count` tasks) and a backend service that is limited to one
  task, including during deployments,
- an encrypted EFS file system for the Convex data, with AWS Backup turned on,
- CloudWatch log groups,
- an execution role that can read only the Secrets Manager ARNs you pass in.

Steps:

1. Create the secrets in Secrets Manager, one per variable name. `CONVEX_INSTANCE_SECRET` is given to the
   backend only. Pass the ARNs as `secret_arns = { SESSION_SECRET = "arn:…", … }`.
2. Push the web image to ECR. Pin `web_image` and `backend_image` by digest.
3. Run `terraform init`, then `terraform plan -var-file=prod.tfvars`, then `terraform apply`.
4. Point the three host names at the `load_balancer_dns_name` output.
5. Generate the admin key with ECS Exec, then run steps 5–6 from the Helm section above.

For offline installs, set `offline = true`. Narrow `egress_cidrs` to your model, embedding, code-host
and identity-provider networks, and add VPC endpoints for ECR, Secrets Manager and CloudWatch Logs so
the tasks no longer need the NAT gateway for AWS services.

## Offline mode

Set `OPENREVIEW_OFFLINE=true` on the web app and on the Convex backend. In offline mode, OpenReview only
contacts:

| Kept | Hosts |
|---|---|
| Model | `LLM_BASE_URL`, or the provider default (`api.openai.com`, `api.anthropic.com`, `openrouter.ai`) |
| Embeddings | `EMBEDDING_BASE_URL`, or the model base URL |
| Code hosts | GitHub or GitHub Enterprise, GitLab, Bitbucket Cloud or Data Center, Gitea, Azure DevOps, Origin, Perforce, as connected (`SCM_ALLOWED_HOSTS` for self-managed hosts) |
| Single sign-on | The SAML or OIDC identity providers that workspace admins configure |

Everything else is turned off. Each feature tells people why:

| Turned off | What people see |
|---|---|
| OSV advisory lookups (`api.osv.dev` or `OSV_API_URL`) | Dependency checks fall back to the local patterns, the same as `OSV_ENABLED=false` |
| Linear, Atlassian (Jira, Confluence) and Notion | Settings → Integrations shows an offline notice and no connect buttons. Reviews skip ticket lookups and add a coverage note. Existing connections are kept as they are. |
| Slack | Settings → Notifications shows that Slack is off. No Slack messages are sent. |
| Email (Resend) | Email sign-in, invitations and notification emails are hidden or skipped |
| Stripe billing | Stripe calls fail with an offline error. Leave `BILLING_ENABLED` off when self-hosting. |
| Send to Devin | The button is hidden |
| Google sign-in | The button is hidden, and the route returns 503 |
| MCP client metadata documents | The authorization server advertises `client_id_metadata_document_supported: false`. Clients register with Dynamic Client Registration instead. |
| Feature tips | No tips appear in review summaries |

## Egress list

Hosts that the running services contact, apart from your own web, backend and identity-provider hosts:

| Host | Used for | Offline |
|---|---|---|
| Model and embedding endpoints | Reviews, chat, indexing | kept |
| Code hosts (see above), `forge.cdn.prod.atlassian-dev.net` (Bitbucket Forge signing keys), `api.cursor.com` (Origin) | Pull requests, comments, checks, repository content | kept |
| `api.osv.dev` | Vulnerability advisories | off |
| `api.linear.app`, `auth.atlassian.com`, `api.atlassian.com`, `api.notion.com` | Requirements context | off |
| `slack.com` | Notifications and questions | off |
| `api.resend.com` | Email | off |
| `api.stripe.com` | Billing (cloud only) | off |
| `api.devin.ai` | Send to Devin | off |
| `oauth2.googleapis.com`, `openidconnect.googleapis.com` | Google sign-in | off |
| Client metadata URLs chosen by MCP clients | MCP OAuth client identification | off |

A self-managed GitLab connection can reach its API through an HTTPS proxy that the operator allows in
`SCM_ALLOWED_PROXIES`, with an internal API URL and a private CA bundle. See [gitlab.md](gitlab.md).

Hosts needed when you build and deploy, but not at runtime:

- **Container registries.** `ghcr.io` for the Convex backend image, and your registry for the web image.
- **The npm registry, or a mirror.** `pnpm install` needs it when you build the web image. `convex deploy`
  also needs it: the backend installs the two external packages declared in `convex.json`
  (`web-tree-sitter` and `tree-sitter-wasms`) when the functions are pushed. Air-gapped installs must
  provide an npm mirror at that step.
- **Terraform.** `registry.terraform.io` for the `hashicorp/aws` provider.

## Tree-sitter grammars

Indexing parses Python, Go, Java, Kotlin, Rust, Ruby, C#, PHP, C, C++, Swift and Elixir with
tree-sitter. TypeScript and JavaScript use the TypeScript compiler. Grammars are always read from local
files and are never downloaded at runtime. To ship a fixed, verified set:

1. Run `pnpm tsx scripts/bundle-grammars.ts deploy/grammars`. This copies the runtime and exactly the
   supported grammars, and writes `manifest.json` with each file's SHA-256 and the package versions.
2. Make the directory available to the Convex backend, for example as an image whose `/grammars` holds
   it, with `config.grammars.enabled` and `config.grammars.image` in the chart.
3. Set `OPENREVIEW_GRAMMARS_DIR=/grammars` in the backend environment. A file whose hash does not match
   the manifest is refused, and files in that language fall back to line-based symbol matching.

## Verify

These tools are not part of the repository checks. Run them where they are installed:

```sh
helm lint deploy/helm/openreview
helm template review deploy/helm/openreview --set secrets.existingSecret=openreview-secrets
terraform -chdir=deploy/terraform/aws init -backend=false
terraform -chdir=deploy/terraform/aws validate
```

`pnpm test` runs `tests/deploy-kit.test.ts`. It checks that every `.Values` reference and helper
exists, that every Terraform variable, local and resource reference resolves, that the backend image
is pinned and runs as a single writer, and that the Convex instance secret never reaches the web app.
`tests/offline-mode.test.ts` and `tests/offline-mode.spec.ts` check that offline mode sends no requests
to any of the turned-off hosts, and still reaches the model, embedding and code hosts.
