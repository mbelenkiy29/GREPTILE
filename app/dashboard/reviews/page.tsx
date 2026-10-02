import { ReviewsTable } from "@/components/dashboard/ReviewsTable";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listReviews } from "@/lib/data/reviews";

export default async function ReviewsPage() {
  const { orgId } = await requireOrg();
  const reviews = await listReviews(db(), orgId);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Reviews</h1>
        <span className="dim">{reviews.reduce((n, r) => n + r.creditsUsed, 0)} credits used</span>
      </div>
      <div className="table-wrap">
        <ReviewsTable reviews={reviews} />
      </div>
    </div>
  );
}
