import { SignInOptions } from "./sign-in";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; email?: string; signedout?: string }>;
}) {
  const { error, email, signedout } = await searchParams;
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
          {error === "link" ? "That sign-in link is invalid, expired or already used. Request a new one." : "Sign-in failed. Check the OAuth callback URL and server configuration, then try again."}
        </p>
      )}
      {email === "sent" && <p role="status">Check your inbox for a sign-in link. It expires in 15 minutes.</p>}
      {email === "error" && <p role="alert" className="error">The sign-in link could not be sent. Check the address, or try again in a few minutes.</p>}
      {signedout && <p role="status">You have been signed out.</p>}
      <SignInOptions />
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
