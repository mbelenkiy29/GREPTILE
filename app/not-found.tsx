import Link from "next/link";

export default function NotFound() {
  return <main className="welcome"><div className="brand"><span className="mark">⌘</span> OpenReview</div><h1>Page not found</h1><p>The page you asked for does not exist.</p><p><Link href="/">Home</Link> · <Link href="/docs/quickstart">Docs</Link></p></main>;
}
