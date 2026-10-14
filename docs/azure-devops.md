# Azure DevOps

OpenReview reviews pull requests in Azure Repos (Azure DevOps Services) through the REST API 7.1.

## Connect

1. Choose a credential, either:
   - **A PAT** for a dedicated service account, with Code (Read & write), Code (Status) and Pull Request Threads (Read & write).
   - **A Microsoft Entra service principal** added to the organization with the same access, entered as JSON: `{"tenantId":"…","clientId":"…","clientSecret":"…"}`. OpenReview obtains short-lived tokens with the client-credentials flow and caches them in memory.
2. Go to **Settings → Code Providers → Connect provider** and choose **Azure DevOps**.
   - **Instance URL:** your organization, for example `https://dev.azure.com/fabrikam`.
   - **Webhook secret:** at least 32 random characters. Keep a copy for step 3.
3. In each Azure DevOps project, open **Project settings → Service hooks** and add **Web Hooks** subscriptions:
   - **Events:** **Pull request created**, **Pull request updated** and **Code pushed**.
   - **URL:** the webhook URL shown for the connection (`<APP_URL>/api/providers/<id>/webhook`).
   - **Authentication:** add the HTTP header `X-OpenReview-Token: <webhook secret>`, or use Basic authentication with the secret as the password.
4. Select repositories and enable them. Repositories appear as `<project>/<repository>`.

## What OpenReview does

- **Diffs:** Azure DevOps reports changed files without patches, so OpenReview computes each file's diff from the merge-base and head blobs of the latest pull request iteration. Binary files and files over 200 KB are listed as skipped.
- **Findings:** each finding is a comment thread on the exact line, tracked across iterations. Re-publishing reuses existing threads.
- **Summary:** one summary thread, edited in place on later reviews. It is closed so it never blocks "comments must be resolved" branch policies.
- **Status:** a pull request status with the `openreview` context is pending while reviewing, then succeeded, failed or not applicable, linking to the dashboard.
- **Indexing:** pushes to the default branch re-index the repository.

## Limits

- Follow-up `@openreview` commands in comments are not yet supported on Azure DevOps.
- Automatic approval is not available.
- Azure DevOps Server (on-premises) may work at its collection URL, but it has not been verified.
