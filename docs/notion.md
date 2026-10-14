# Notion requirements context

OpenReview can use Notion pages as read-only requirements context when a pull request links to them.

## Setup (operator)

1. Create a **public** Notion integration at https://www.notion.so/profile/integrations.
   - Capabilities: **Read content** only.
   - Redirect URI: `<APP_URL>/api/integrations/notion/callback`.
2. Set `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` on both the web application and Convex.

## Connecting (workspace admin)

1. Open **Memory → Integrations → Connect Notion workspace**. Notion's page picker decides which pages OpenReview can read; you can change it later in Notion from a page's **Connections** menu.
2. Select the repositories allowed to use those pages. The settings page lists the shared pages it can see.

## What gets fetched

- **Which pages:** only `notion.so`/`*.notion.site` page links in the pull request title, description or branch. At most 10 pages per connection are fetched.
- **Content:**
  - Each page is converted to plain text: headings, lists, to-dos, quotes, code, and one nested level.
  - Each page is capped at 100 KB, with a visible truncation marker.
  - Requirements from Linear, Atlassian and Notion together are capped at 100 KB.
  - Archived pages are skipped.
- **Data handling:** page text is untrusted data. Findings cite it with the page URL and its last-edited time as the revision.

## Tokens

- **Storage:** credentials are encrypted with `CREDENTIAL_ENCRYPTION_KEY`.
- **When Notion returns 401:**
  - If Notion issued a refresh token, OpenReview refreshes it once under a lease and retries.
  - If there is no refresh token, or the refresh is rejected, the page is skipped and the connection shows a reconnect prompt.
- **Disconnect:** local access is removed immediately and the token is revoked at Notion (`POST /v1/oauth/revoke`).
  - Failed revocations are retried up to three times.
  - After that, the connection asks you to remove OpenReview under Notion **Settings → Connections**.
