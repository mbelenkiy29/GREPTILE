# Origin personal link acceptance

October 4, 2026. Current production state supersedes the earlier pending-confirmation report: the existing Origin personal identity is **linked**, active, generation 1, and expires October 5, 2026 at 16:01:01 UTC. The immutable mixed-case native user ID is preserved. Audit activity records `provider.identity.linked` at October 4, 16:01:01 UTC.

The deployed linking path verifies the signed user-confirmation receipt, installation, namespace, state and one-use receipt ID before saving the encrypted identity assertion. It also performs actual native selected-repository read verification. Current readback did not submit another consent or expand permissions.

A fresh native access check independently used the saved assertion and existing App credentials to mint a short-lived token with only repository metadata, contents and pull-request read scopes for the one selected repository `r_01m421v82efh88nejzh0yvxm07`. The native repository identity and namespace matched. The delegated token remained in memory and was not persisted or printed. Native consent, repository settings, source contents, review state and model inference were unchanged.

Computer use verified Personal agents displays the linked principal and exact UTC expiry with a Disconnect provider identity action. Earlier pending-confirmation tabs are gone; no new consent page was created or clicked.

Evidence in ignored `output/setup/`: `origin-personal-current-readback-evidence.json`, `origin-personal-native-readback-evidence.json`, their read-only scripts and `origin-personal-linked-live.png`.

This establishes live personal-link persistence, current UI state and exact selected-repository delegated read access. It does not establish revocation/expiry through the native UI, cross-repository review publication or successful follow-up authorization. The App collaborator permission endpoint previously returned 404; personal read access alone is not proof of author write permission. Human-reviewed fix push and updated-revision resolution remain pending.


Subsequent context acceptance: actual bidirectional GitHub/Origin retrieval and deployed publication-guard validation now pass with personal primary/source access checked before and after reads. See [context authorization acceptance](origin-context-authorization-acceptance.md). No new AI review was published; native expiry/revocation and follow-up write authorization remain unverified.
