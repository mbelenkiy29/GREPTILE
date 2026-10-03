import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoResultView } from "@/components/demo/DemoResultView";
import { Brand } from "@/components/shell/Brand";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { db } from "@/lib/db";
import { getDemoReview } from "@/lib/demo/view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Demo review", robots: { index: false, follow: false } };

/** A public demo review (R3.7) by its unguessable id; refreshes itself while the review runs. */
export default async function DemoReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const review = await getDemoReview(db(), (await params).id);
  if (!review) notFound();
  const active = review.status === "queued" || review.status === "running";
  return (
    <main className="demo-page">
      <AutoRefresh active={active} intervalMs={4000} />
      <header className="demo-header">
        <Brand href="/" />
      </header>
      <DemoResultView review={review} />
    </main>
  );
}
