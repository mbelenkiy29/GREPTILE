import Link from "next/link";
import { LogoMark } from "@/components/ui/icons";

/** The OpenReview wordmark with its mark, linking home. */
export function Brand({ href = "/dashboard", size = 26 }: { href?: string; size?: number }) {
  return (
    <Link href={href} className="brand" aria-label="OpenReview home">
      <LogoMark size={size} />
      <span className="brand-word">
        <b>Open</b>
        <span>Review</span>
      </span>
    </Link>
  );
}
