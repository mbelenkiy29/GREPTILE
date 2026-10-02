import Link from "next/link";
import { notFound } from "next/navigation";
import { ReviewDetailView } from "@/components/dashboard/ReviewDetailView";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { getReviewDetail } from "@/lib/data/reviews";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const id = Number((await params).id);
  const review = Number.isSafeInteger(id) ? await getReviewDetail(db(), orgId, id) : undefined;
  if (!review) notFound();
  return (
    <div className="stack">
      <Link href="/dashboard/reviews" className="dim">
        ← All reviews
      </Link>
      <ReviewDetailView review={review} />
    </div>
  );
}
