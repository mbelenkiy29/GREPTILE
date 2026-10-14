# Inference budget reconciliation

Verified October 4, 2026 through computer use in the signed-in OpenAI platform. The configured local evaluation key equals the hosted inference key; the configured secret's masked suffix matches the native OpenReview-local key row. The key was created October 2. No secret was printed and no key/access/budget settings were changed.

The native key-filtered Usage dashboard displays $4.38. A Cost data export grouped by API Key and filtered to OpenReview-local retains the matching native tracking ID on every billed row. Decimal arithmetic over the CSV yields **$4.3846788 USD**, covering October 1 through October 4 UTC, including the current partial day's bucket ending October 5. The nominal remainder under the user-authorized $5 cap is **$0.6153212** at the observed snapshot. This replaces the incomplete application-log lower bound as aggregate provider-spend evidence; it does not reconstruct the individual costs or quality outcomes of failed historical evaluations.

Daily reported amounts:

| UTC day | Reported USD |
| --- | ---: |
| October 2 | 2.0953728 |
| October 3 | 1.624844 |
| October 4 (partial) | 0.664462 |

No inference was requested during reconciliation. Provider data can lag active calls; any future paid acceptance run requires a fresh provider snapshot and a conservative maximum-call budget within the remaining cap. The application does not yet implement an organization-wide hard currency cap across concurrent review/indexing jobs. Unbounded evaluations or agent launches are not authorized by this remaining amount.

OpenAI recommends its Costs data for invoice reconciliation rather than treating Usage token summaries as billing totals: [official usage guidance](https://help.openai.com/en/articles/10478918-reviewing-api-usage-and-costs), [Costs API reference](https://platform.openai.com/docs/api-reference/usage). No Admin API key was created.

Ignored acceptance artifacts: output/setup/provider-key-costs.csv (retained native export), provider-key-cost-evidence.json (decimal totals/provenance/hash), provider-key-cost-dashboard.png (key-filtered dashboard). The original downloaded CSVs remain in Downloads. No application code, schema, configuration or deployment changed; latest full checks remain 306 tests, lint, typecheck and build. The locked Mac still prevents native responsive acceptance, and the full provider/OS matrix remains incomplete.


## October 4, 17:18 UTC refresh and Origin follow-up

A fresh native Cost data CSV grouped/filtered to OpenReview-local again reports $4.3846788, with the same three billed day totals. Subsequently the authorized existing Origin question generated two conversation usage records totaling $0.014128; final native readback confirms one published answer and completed recovery. The original one-generation ceiling omitted automatic worker retries and is superseded: complete configured retries could have cost $0.952974 rather than $0.317658. No further paid acceptance is scheduled until a fresh provider total and a complete multi-layer bound or durable reservation exist. $4.3988068 is only the pre-call provider snapshot plus newly recorded application cost, not an authoritative refreshed provider total. Conversation costs are in usageEvents; modelCalls counts alone do not include them. See [full follow-up evidence](origin-followup-personal-acceptance.md).


## October 4 durable hosted cap activated

Fresh native key-filtered dashboard now shows $4.40 (rounded). The hosted deployment is sealed at $5 with a conservative $4.50 historical baseline and $0.50 initially reservable; this is not a claim of $4.50 actual provider spend. Every hosted model/embedding attempt now reserves atomically, including inner and outer retries; missing receipts retain capacity. Live over-budget refusal and baseline-reset rejection pass without inference. [Enforcement, evidence and standalone-CLI limits](inference-budget-acceptance.md). This supersedes the earlier statement that no hosted hard currency cap exists; it does not retroactively validate the earlier incomplete retry preflight.
