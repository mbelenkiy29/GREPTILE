# Perforce mobile outage acceptance

Verified October 4, 2026 on the hosted production release `dpl_F5ySK8EfUgxrHd3auPiPRc8UGPd2`, with Convex `tidy-ocelot-457`.

At an actual 390×844 Chrome viewport, the existing Perforce catalog was filtered to `openreview-native-acceptance`. One click on “Review current revision for #26” encountered the unavailable provider hostname. The page showed a bounded recovery alert, re-enabled the button and retained document/body widths of 390 pixels. No browser warnings or errors were captured. Refresh cleared the alert, retained the repository filter and restored the available button without submitting another request. The temporary viewport was reset.

Independent backend receipts before and after the failed request show six reviews, 45 model calls and recorded model-call cost $0.180404, unchanged. Review #26 retains its open catalog state and exact revision `p4:26:1:27:034682bf95b8fa9ee94d6ba628a6df6a8c1f0d4179a98a14cc14c9cf417fe4ea`. Polling remains disabled. No review or inference was scheduled.

The outage investigation found three independent fixture problems:

- The previous Perforce, GitLab and Gitea quick-tunnel hostnames no longer resolve, and no `cloudflared` process is running. Local containers remain up. These temporary public endpoints do not establish durable external availability.
- The existing Swarm service ticket expired. It was refreshed for the same `swarm` identity with unchanged groups and permissions; the generated configuration cache was rebuilt.
- The Colima Docker data disk was full. Two explicitly identified, reclaimable private build-cache records were pruned using Docker's supported ID filter. This reclaimed 554.2 MB of cache accounting and restored 299 MiB of available filesystem space. No containers, images, repository data, volumes or logs were deleted, and no service was restarted. The approved digest-pinned Node runtime image remains present. Disk capacity still needs attention before further substantial fixture builds.

After disk recovery, the old `review-bot` ticket returned HTTP 401. Its existing ticket was refreshed with unchanged permissions and stored in the existing private local receipt. Local Swarm readback then confirmed review #26 is still `needsReview`, pending, version change 26 with archive change 27. No native review-state mutation occurred. This local credential has **not** been adopted by the hosted connection: its public hostname is still unavailable. Hosted credential renewal and any credential-bound indexing must be verified after a reachable provider endpoint is restored. No persistent watcher or automatic policy was enabled.

Evidence under ignored `output/setup/`:

- `p4-mobile-disconnected-{before,after}-evidence.json` and corresponding logs.
- `p4-mobile-disconnected-error-live.png` and `p4-mobile-disconnected-refreshed-live.png`.
- `p4-mobile-native-readback-evidence.json` and `p4-mobile-local-readback.ts`.
- `p4-native/swarm-service-renewal-evidence.json` and renewal script.

An initial invocation of the older catalog script refreshed its historical `p4-catalog-review-before-evidence.json` timestamp; it is not the original historical receipt. The independently named mobile receipts above are the evidence for this check.

This closes mobile failure-display, retry-control restoration and refresh recovery acceptance for the unavailable Perforce catalog request. It does not establish successful review dispatch, agent launch, public endpoint recovery or full provider parity. Application code and deployment are unchanged; the latest full verification remains 171 Node + 140 Convex = 311 tests, lint, typecheck and production build.
