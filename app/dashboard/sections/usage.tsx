import { repositoryDisplay } from "../../../src/provider-display";
import { ScrollTable } from "../scroll-table";
import type { DashboardContext } from "../load";

export function UsageSection({ ctx }: { ctx: DashboardContext }) {
  const { data } = ctx;
  return (
(
          <>
            <p>
              Workspace cost: $
              {data.usage
                .reduce((sum, event) => sum + event.estimatedCost, 0)
                .toFixed(4)}{" "}
              · Indexing embeddings: $
              {data.usage
                .filter((event) => event.kind === "embedding")
                .reduce((sum, event) => sum + event.estimatedCost, 0)
                .toFixed(4)}
            </p>
            <p>
              Average completed review: $
              {(() => {
                const completed = new Set(
                  data.reviews
                    .filter((review) => review.status === "completed")
                    .map((review) => review._id),
                );
                return completed.size
                  ? (
                      data.usage
                        .filter(
                          (event) =>
                            event.reviewId && completed.has(event.reviewId),
                        )
                        .reduce((sum, event) => sum + event.estimatedCost, 0) /
                      completed.size
                    ).toFixed(4)
                  : "0.0000";
              })()}{" "}
              · Duration:{" "}
              {(() => {
                const completed = data.reviews.filter(
                  (review) =>
                    review.status === "completed" && review.finishedAt,
                );
                return completed.length
                  ? `${Math.round(completed.reduce((sum, review) => sum + (review.finishedAt! - review.createdAt), 0) / completed.length / 1000)} seconds`
                  : "Awaiting reviews";
              })()}
            </p>
            <p>
              Estimated costs use your configured input and output token prices.
              A zero cost means pricing has not been configured or the call was
              cached.
            </p>
            <ScrollTable label="Repository usage table">
              <table>
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Model calls</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Estimated cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.repositories.map((r) => {
                    const usage = data.usage.filter(
                      (u) => u.repositoryId === r._id,
                    );
                    return (
                      <tr key={r._id}>
                        <td>{repositoryDisplay(r)}</td>
                        <td>{usage.length}</td>
                        <td>
                          {usage
                            .reduce((s, u) => s + u.inputTokens, 0)
                            .toLocaleString()}
                        </td>
                        <td>
                          {usage
                            .reduce((s, u) => s + u.outputTokens, 0)
                            .toLocaleString()}
                        </td>
                        <td>
                          $
                          {usage
                            .reduce((s, u) => s + u.estimatedCost, 0)
                            .toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTable>
            <p className="muted">Most recent 1,000 usage events.</p>
          </>
        )
  );
}
