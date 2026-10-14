import Link from "next/link";
import { Mark } from "./ui/logo";

export default function NotFound() {
  return <main className="welcome"><Link className="brand" href="/"><Mark /> OpenReview</Link><h1>Page not found</h1><p>The page you asked for does not exist.</p><p><Link href="/">Home</Link> · <Link href="/docs/quickstart">Docs</Link></p></main>;
}
