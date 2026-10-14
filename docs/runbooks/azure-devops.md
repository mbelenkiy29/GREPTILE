# Runbook: Azure DevOps

**Goal:** verify the Azure Repos adapter end to end. It has only been tested against a fake API.

## Prerequisites

- An Azure DevOps organization and a test project with a Git repository.
- A dedicated service account. Use either:
  - **A PAT** with Code (Read & write), Code (Status) and Pull Request Threads (Read & write).
  - **An Entra service principal** added to the organization with the same access.

## Steps

1. Connect via **Settings → Code Providers → Azure DevOps**:
   - **Instance:** `https://dev.azure.com/<org>`.
   - **Credential:** the PAT, or `{"tenantId","clientId","clientSecret"}`.
   - **Webhook secret:** 32+ characters.
2. In **Project settings → Service hooks**, add Web Hooks for:
   - Pull request created.
   - Pull request updated.
   - Code pushed.

   Use the shown URL and the HTTP header `X-OpenReview-Token: <secret>`.
3. Enable the repository and wait for **index ready**.
4. Open a pull request with a seeded bug. Confirm:
   - [ ] Comment threads on the exact lines.
   - [ ] A single **closed** summary thread.
   - [ ] The `openreview` status goes pending, then succeeded or failed.
5. Push another commit. Confirm:
   - [ ] The finding threads are reused (no duplicates).
   - [ ] The summary is edited.
6. Push to the default branch. Confirm:
   - [ ] The repository re-indexes.
7. Change the service hook header to a wrong value. Confirm:
   - [ ] Deliveries are rejected (401).
   - [ ] No review runs.

## Evidence

Record:
- The PR URL and iterations.
- Screenshots of a finding thread, the summary and the status.
- The service hook delivery history.

## Cleanup

Abandon the PR, delete the service hooks, and revoke the PAT or remove the service principal.
