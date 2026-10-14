# Security policy

Do not post live credentials, private repository source, or exploitable deployment details in public issues. Contact the operator of the affected OpenReview installation privately; until a project maintainer security address is established, use a private repository security advisory rather than a public issue.

Operators must use HTTPS for web/backend, strong independent secrets, protected Convex administrative endpoints, trusted reverse proxies, encrypted disks/backups, and current dependency patches. Restrict inbound access and model endpoint configuration. Keep GitHub App private keys out of client environments. Rotate compromised App/model/API/session credentials promptly.

The application verifies webhook HMACs, OAuth/install state, signed session tokens, tenant membership, model response schemas, and finding evidence. API keys are stored only as hashes. Repository secrets receive defensive redaction, but pattern-based redaction cannot guarantee removal of all secrets. Limit App repository access and approve external model data processing before enabling reviews on sensitive code.

Untrusted repository code must never run on the application host. Optional runtime validation must use an isolated container with explicit limits and no application secrets. Source/model text cannot grant permissions or change system instructions.

No production security audit or Greptile parity is claimed. Report suspected tenant isolation, webhook authentication, or unsafe execution defects with a minimal reproduction and affected version.
