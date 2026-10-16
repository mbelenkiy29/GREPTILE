# Privacy Policy

**Effective October 15, 2026**

This policy explains what information the hosted OpenReview service at [openreview.tech](https://openreview.tech) collects, how it is used and shared, and the choices you have. OpenReview is operated by Michael Belenkiy ("we", "us"). Questions and requests go to [mbelenkiy29@gmail.com](mailto:mbelenkiy29@gmail.com).

OpenReview is also open-source software. If you run it on your own infrastructure, this policy does not apply: your installation is operated by you, and no data is sent to us.

## Information we collect

**Account information.** When you sign in with GitHub we receive your username, account ID, avatar image URL and, when GitHub provides it, your email address and whether it is verified. If other sign-in methods are offered (GitLab, Google or an emailed sign-in link), we receive the equivalent details from that provider.

**Workspace information.** This includes:
- workspace and team names, members and their roles;
- invitations, including invited email addresses or usernames;
- review settings and rules;
- an audit log recording which member made which administrative change and when.

**Repository and pull request content.** When a workspace installs our GitHub App (or connects another code host) and selects repositories, we access and store what we need to review code:
- file paths and file contents, and code snippets;
- symbols and references between files;
- search indexes derived from the code;
- pull request titles, descriptions, diffs, commits, comments and reactions;
- the reviews, findings, summaries and chat answers we generate.

**Integration content.** When a workspace admin connects Linear, Jira, Confluence, Notion or Slack, we receive the content needed for the features you turn on. Examples are tickets or pages linked from a pull request, and Slack messages that ask OpenReview a question. We store integration access tokens encrypted.

**Billing information.** Payments are handled by Stripe. We receive and store your Stripe customer and subscription identifiers, plan status, seat count and billing dates. We never receive or store full card numbers.

**Technical and usage information.** We record:
- sign-in sessions, with the sign-in provider, the browser's user-agent string and timestamps;
- review and AI usage counts;
- API key and webhook activity.

Our hosting providers keep server logs that include IP addresses.

**Error reports and analytics.** We use Sentry to learn about errors and PostHog to understand how the site is used.
- **Sentry receives:** error reports with technical details, and performance timings for a sample of page loads.
- **PostHog receives:** page views, and clicks on public pages such as the home page and documentation.
- **What identifies you:** after you sign in, both tools identify you only by an internal user ID and workspace ID.
- **What is never sent:**
  - the text of what you click or read on signed-in pages;
  - your code or AI output;
  - request contents;
  - session recordings;
  - private details from page addresses, such as invitation links and sign-in codes.
- **Your permission comes first:** PostHog runs only after you accept the analytics cookie. Sentry sets no cookies.

**Cookies.** Most of our cookies are needed for the service to work:
- your sign-in session;
- your active workspace and team;
- short-lived security cookies for sign-in and connecting integrations;
- your theme preference;
- one-time notices.

If you allow it, PostHog also stores a random identifier in a cookie and in your browser's local storage, so we can count visits and see how people use the site.
- **When we ask:** on your first visit. Until you accept, PostHog does not run and sets nothing.
- **When we don't ask:** if your browser sends a Do Not Track or Global Privacy Control signal, we treat that as a no and PostHog stays off.
- **Remembering your choice:** your choice is kept in a cookie for 180 days.
- **Changing your mind:** use **Cookie settings** at the bottom of any page.

We do not use advertising cookies, and we do not use cookies to track you across other websites.

## How we use information

We use the information above to:
- provide the service: indexing repositories, reviewing pull requests, posting comments, answering questions and sending notifications;
- authenticate you, keep accounts and workspaces secure, and prevent abuse;
- process subscriptions and enforce plan limits;
- respond to support requests and send service messages, such as sign-in links, invitations and billing notices;
- keep the service reliable, diagnose problems and understand which features are used;
- meet legal obligations.

We do not sell personal information, and we do not use it for advertising.

Feedback you give on reviews, such as reactions, replies and approved rules, is used only to tune reviews within your own workspace. It is not shared with other workspaces.

## AI processing

To review code and answer questions, we send the relevant code, diffs and context to an AI model provider through its API; currently that is OpenAI. We use API services whose terms say that content sent through the API is not used to train their models. We do not use your code or content to train AI models.

## Who we share information with

We share information only as needed to run the service, with:

| Provider | Purpose |
|---|---|
| Vercel | Website hosting |
| Convex | Database and backend processing |
| OpenAI | AI model processing for reviews and answers |
| Stripe | Payments and subscriptions |
| GitHub (and other code hosts you connect) | Sign-in and repository access |
| OSV.dev | Checking package names and versions from dependency changes for known vulnerabilities (no source code is sent) |
| Sentry | Error reports and performance monitoring |
| PostHog | Product analytics |
| Linear, Atlassian, Notion, Slack | Only when your workspace connects them |
| An email delivery provider | Only when email sign-in or email notifications are turned on |

Information is also shared:
- **With your workspace:** other members of your workspace can see its repositories, reviews and settings, according to their roles. Comments OpenReview posts on pull requests are visible to anyone who can see those pull requests on your code host.
- **For legal reasons:** when required by law, or to protect the rights, safety and security of our users or the service.
- **If OpenReview is sold:** if the service is transferred to a new operator, information would move with it under this policy, and we would tell you first.
- **With your consent:** in any other case, only when you agree.

## How long we keep information

We keep information while your account or workspace is active. If you ask us to delete your account or workspace, we delete it within 30 days. Copies in backups are removed within 90 days. Billing records are kept as long as tax and accounting law requires.

Uninstalling the GitHub App or removing a repository stops our access to it. To have that repository's stored data deleted as well, email us.

## Your choices and rights

- **Your requests:** you can ask us to access, correct, export or delete your personal information by emailing [mbelenkiy29@gmail.com](mailto:mbelenkiy29@gmail.com). We respond within 30 days.
- **In the product:** you can sign out of other sessions in **Settings → Account**. Admins can disconnect integrations and remove repositories at any time.
- **Analytics:** turn analytics off at any time with **Cookie settings** at the bottom of any page, or with your browser's Do Not Track or Global Privacy Control setting.
- **Regional rights:** depending on where you live, for example in the EU, UK or California, you may have additional rights, such as objecting to processing or complaining to a data protection authority. We honor these rights for everyone.
- **No selling:** we do not sell or share personal information for cross-context behavioral advertising.

## Where information is processed

We and our providers process and store information in the United States. If you use the service from elsewhere, your information is transferred to the United States.

## Security

We protect information with:
- encrypted connections;
- session tokens that are stored only in hashed form;
- encrypted integration credentials;
- the narrowest code-host permissions each feature needs;
- access limited to what the service requires.

No system is perfectly secure. If a breach affects your information, we will notify you as the law requires.

## Children

OpenReview is a tool for software teams and is not intended for anyone under 16. We do not knowingly collect information from children.

## Changes to this policy

When we update this policy we change the effective date above. If a change is significant, we will also tell signed-in users by email or in the product before it takes effect.

## Contact

Michael Belenkiy · [mbelenkiy29@gmail.com](mailto:mbelenkiy29@gmail.com)
