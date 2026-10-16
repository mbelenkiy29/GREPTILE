import path from "node:path";

// Public documentation served at /docs. Files are Markdown under docs/ (rendered statically);
// internal QA logs (docs/internal) and operator runbooks are deliberately not published.
export type DocPage = { slug: string; title: string; description: string; section: string; file: string };
export const docPages: DocPage[] = [
  { slug: "quickstart", title: "Quickstart", description: "Run OpenReview locally and review your first pull request.", section: "Getting started", file: "public/quickstart.md" },
  { slug: "github-app", title: "GitHub App setup", description: "Register the GitHub App, permissions and webhooks.", section: "Getting started", file: "public/github-app.md" },
  { slug: "reviews", title: "How reviews work", description: "Context, verification, publishing and pull request commands.", section: "Getting started", file: "public/reviews.md" },
  { slug: "configuration", title: "Repository configuration", description: ".openreview.json, rules.md and admin locks.", section: "Configure", file: "repo-config.md" },
  { slug: "rules", title: "Custom rules", description: "Team rules from the dashboard and repository files.", section: "Configure", file: "public/rules.md" },
  { slug: "agentic-review", title: "Agentic review", description: "The tool-using review engine and its budgets.", section: "Configure", file: "agentic-review.md" },
  { slug: "code-graph", title: "Code graph", description: "How repositories are parsed and linked across files.", section: "Configure", file: "code-graph.md" },
  { slug: "gitlab", title: "GitLab", description: "GitLab.com and self-managed GitLab.", section: "Providers", file: "gitlab.md" },
  { slug: "bitbucket-cloud", title: "Bitbucket Cloud", description: "Bitbucket Cloud through Forge.", section: "Providers", file: "bitbucket-cloud.md" },
  { slug: "bitbucket-data-center", title: "Bitbucket Data Center", description: "Self-hosted Bitbucket.", section: "Providers", file: "bitbucket-data-center.md" },
  { slug: "gitea", title: "Gitea", description: "Gitea and Forgejo.", section: "Providers", file: "gitea.md" },
  { slug: "azure-devops", title: "Azure DevOps", description: "Azure Repos pull requests with PAT or Entra auth.", section: "Providers", file: "azure-devops.md" },
  { slug: "perforce", title: "Perforce", description: "Perforce shelves and submitted revisions.", section: "Providers", file: "perforce.md" },
  { slug: "origin", title: "Origin", description: "Origin repositories.", section: "Providers", file: "origin.md" },
  { slug: "chat", title: "Codebase chat", description: "Cited answers about your repositories.", section: "Use", file: "public/chat.md" },
  { slug: "notifications", title: "Slack and email", description: "Notifications, Slack Q&A and email.", section: "Use", file: "notifications.md" },
  { slug: "linear", title: "Linear", description: "Requirements context from Linear issues.", section: "Use", file: "linear.md" },
  { slug: "atlassian", title: "Jira and Confluence", description: "Requirements context from Atlassian.", section: "Use", file: "atlassian.md" },
  { slug: "notion", title: "Notion", description: "Requirements context from Notion pages.", section: "Use", file: "notion.md" },
  { slug: "api", title: "Public API", description: "API keys, scopes and endpoints.", section: "Developers", file: "public/api.md" },
  { slug: "mcp", title: "MCP", description: "Remote and local Model Context Protocol servers.", section: "Developers", file: "public/mcp.md" },
  { slug: "agent-plugins", title: "Agent plugins", description: "Claude Code and Codex plugins and the resolve loop.", section: "Developers", file: "public/agent-plugins.md" },
  { slug: "cli", title: "CLI", description: "Local reviews and the coding-agent bridge.", section: "Developers", file: "public/cli.md" },
  { slug: "self-hosting", title: "Self-hosting", description: "Run OpenReview on your own infrastructure.", section: "Operate", file: "public/self-hosting.md" },
  { slug: "deployment", title: "Deployment guide", description: "Docker Compose, backups and upgrades.", section: "Operate", file: "deployment.md" },
  { slug: "identity", title: "Sign-in and sessions", description: "Providers, account linking and sessions.", section: "Operate", file: "identity.md" },
  { slug: "billing", title: "Billing (cloud)", description: "Plans, quotas and Stripe setup for hosted deployments.", section: "Operate", file: "billing.md" },
  { slug: "observability", title: "Error tracking and analytics (cloud)", description: "What Sentry and PostHog collect on the hosted site, and how to configure them.", section: "Operate", file: "observability.md" },
  { slug: "runtime-worker", title: "Runtime worker", description: "Recorded test execution for reviews.", section: "Operate", file: "runtime-worker.md" },
];
export const docBySlug = (slug: string) => docPages.find((d) => d.slug === slug);

// Maps a Markdown link inside a published doc to a site URL: other published docs become
// /docs/<slug>; external links stay; anything else (internal files) renders as plain text.
export function resolveDocLink(fromFile: string, href: string): { kind: "external" | "doc" | "anchor" | "text"; url?: string } {
  if (/^https?:\/\//.test(href)) return { kind: "external", url: href };
  if (href.startsWith("#")) return { kind: "anchor", url: href };
  if (href === "/docs/openapi.yaml" || href.startsWith("/docs/")) return { kind: "doc", url: href };
  const [target, hash] = href.split("#");
  if (!target.endsWith(".md")) return { kind: "text" };
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  const page = docPages.find((d) => d.file === file);
  return page ? { kind: "doc", url: `/docs/${page.slug}${hash ? "#" + hash : ""}` } : { kind: "text" };
}
