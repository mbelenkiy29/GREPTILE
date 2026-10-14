export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="welcome">
      <div className="brand">
        <span className="mark">⌘</span> OpenReview
      </div>
      <h1>
        Review the change.
        <br />
        Understand the codebase.
      </h1>
      <p>
        Repository-aware code review, running on your infrastructure. Connect
        GitHub, configure your rules, and follow every finding from evidence to
        resolution.
      </p>
      {error && (
        <p role="alert" className="error">
          GitHub sign-in failed. Check the OAuth callback URL and server
          configuration, then try again.
        </p>
      )}
      <a className="button primary" href="/api/auth/login">
        Sign in with GitHub
      </a>
      <div className="welcome-details">
        <span>Bring your model</span>
        <span>Keep your data</span>
        <span>Inspect every finding</span>
      </div>
      <p className="muted">
        Self-hosting setup is documented in the repository README.
      </p>
    </main>
  );
}
