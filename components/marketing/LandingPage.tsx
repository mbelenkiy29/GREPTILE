import Link from "next/link";
import { LogoMark, Icon } from "@/components/ui/icons";
import { EXAMPLE_FINDINGS, HERO, INTEGRATIONS, LANDING_FAQ, PIPELINE_STEPS } from "@/lib/marketing/content";
import { ExampleFindingCard } from "./ExampleFindingCard";
import { PipelineDiagram } from "./PipelineDiagram";

/** The hero's illustration: a pull request diff with an OpenReview comment pinned in the margin. Illustrative only. */
function HeroReview() {
  return (
    <figure className="hero-review" aria-labelledby="hero-review-caption">
      <div className="hero-review-bar" aria-hidden="true">
        <span className="hero-review-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="mono">feat: regional tax at checkout · #482</span>
      </div>
      <div className="hero-review-body">
        <div className="hero-diff mono" aria-hidden="true">
          <div className="hero-diff-file">src/billing/pricing.ts</div>
          <div className="hd-line">
            <span className="hd-n">12</span>
            <span>{"export function computeTotal("}</span>
          </div>
          <div className="hd-line hd-del">
            <span className="hd-n">13</span>
            <span>{"-  items: LineItem[]"}</span>
          </div>
          <div className="hd-line hd-add hd-mark">
            <span className="hd-n">13</span>
            <span>{"+  items: LineItem[], region: Region"}</span>
          </div>
          <div className="hd-line">
            <span className="hd-n">14</span>
            <span>{") {"}</span>
          </div>
          <div className="hd-line">
            <span className="hd-n">15</span>
            <span>{"  const rate = taxRate(region);"}</span>
          </div>
        </div>
        <div className="hero-note">
          <div className="hero-note-head">
            <LogoMark size={18} />
            <b>openreview</b>
            <span className="hero-note-sev">High · correctness</span>
          </div>
          <p>
            <code>handleCheckout</code> and <code>renderCartSummary</code> still call <code>computeTotal(items)</code> without a region. Neither file is in this diff.
          </p>
          <p className="hero-note-foot mono">src/checkout/handler.ts:41 · verified</p>
        </div>
      </div>
      <figcaption id="hero-review-caption" className="hero-review-caption">
        Illustrative example — not from a real repository.
      </figcaption>
    </figure>
  );
}

function SectionHead({ id, eyebrow, title, lede }: { id: string; eyebrow: string; title: string; lede?: string }) {
  return (
    <div className="m-section-head">
      <p className="m-eyebrow">{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      {lede && <p className="m-lede">{lede}</p>}
    </div>
  );
}

const CONFIG_SAMPLE = `{
  "mode": "standard",
  "strictness": "medium",
  "ignore": ["**/__generated__/**"],
  "context": ["CONTRIBUTING.md", "docs/adr/**"],
  "rules": [
    { "rule": "Every query filters by org_id.",
      "paths": ["lib/data/**"] }
  ]
}`;

/**
 * The public landing page (R5.1). Server-rendered; the only client code is the copy buttons on code samples.
 * `demoEnabled` shows the "Try it on a PR" call to action (the public demo, R3.7).
 */
export function LandingPage({ demoEnabled }: { demoEnabled: boolean }) {
  return (
    <>
      <section className="m-hero" aria-labelledby="hero-title" data-section="hero">
        <div className="m-wrap m-hero-grid">
          <div className="m-hero-copy">
            <p className="m-eyebrow">{HERO.eyebrow}</p>
            <h1 id="hero-title" className="m-display">
              {HERO.headline}
            </h1>
            <p className="m-hero-lede">{HERO.lede}</p>
            <div className="m-cta-row">
              <Link href="/sign-in" className="button button-primary button-lg" data-cta="get-started">
                Get started
              </Link>
              <Link href="/docs/self-hosting" className="button button-lg" data-cta="self-host">
                Self-host
              </Link>
              {demoEnabled && (
                <Link href="/try" className="m-cta-link" data-cta="try">
                  Try it on a PR <span aria-hidden="true">→</span>
                </Link>
              )}
            </div>
          </div>
          <HeroReview />
        </div>
      </section>

      <section id="how-it-works" className="m-section" aria-labelledby="how-title" data-section="how-it-works">
        <div className="m-wrap">
          <SectionHead
            id="how-title"
            eyebrow="How it works"
            title="From a diff to a verified review"
            lede="A pull request is a few changed lines in a much larger program. OpenReview reviews it with the rest of the program in view."
          />
          <div className="m-diagram">
            <PipelineDiagram />
          </div>
          <ol className="m-steps">
            {PIPELINE_STEPS.map((s, i) => (
              <li key={s.id} data-step={s.id}>
                <span className="m-step-n" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="m-section m-section-sunken" aria-labelledby="examples-title" data-section="examples">
        <div className="m-wrap">
          <SectionHead
            id="examples-title"
            eyebrow="Example findings"
            title="What a finding looks like"
            lede="Each comment says what is wrong, why it matters, where the evidence is, and how to fix it. These three are illustrative examples written for a fictional codebase, shown with the same layout as the dashboard."
          />
          <div className="m-findings">
            {EXAMPLE_FINDINGS.map((f) => (
              <ExampleFindingCard key={f.id} finding={f} />
            ))}
          </div>
        </div>
      </section>

      <section className="m-section" aria-labelledby="personal-title" data-section="personalization">
        <div className="m-wrap">
          <SectionHead
            id="personal-title"
            eyebrow="Personalization"
            title="Reviews that follow your team's conventions"
            lede="Every team has rules nobody wrote down. Write them down once and they are checked on every pull request."
          />
          <div className="m-personal">
            <div className="m-card">
              <h3>
                <Icon name="rules" size={18} /> Rules in plain English
              </h3>
              <p>Organization-wide or per repository, limited to paths, with a category and a severity. Findings that enforce a rule cite it.</p>
              <p className="m-quote">“Handlers in app/api take the organization from the session, never from the request.”</p>
              <Link href="/docs/rules">Writing rules</Link>
            </div>
            <div className="m-card m-card-code">
              <h3>
                <Icon name="code" size={18} /> openreview.json
              </h3>
              <p>Settings that live with the code. Read from the base branch, so a pull request cannot loosen its own review.</p>
              <pre className="m-code" tabIndex={0} aria-label="Example openreview.json">
                <code>{CONFIG_SAMPLE}</code>
              </pre>
              <Link href="/docs/configuration">Every key</Link>
            </div>
            <div className="m-card">
              <h3>
                <Icon name="spark" size={18} /> Learned preferences
              </h3>
              <p>
                Thumbs up, thumbs down, “false positive”, “ignore this pattern”: feedback becomes readable preferences you can edit or reset. Your
                teammates&apos; own review comments are mined into rules you approve.
              </p>
              <Link href="/docs/learning">How learning works</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="m-section m-section-sunken" aria-labelledby="integrations-title" data-section="integrations">
        <div className="m-wrap">
          <SectionHead id="integrations-title" eyebrow="Integrations" title="Where you already work" lede="On the pull request, in the terminal, and inside your coding agent." />
          <ul className="m-integrations">
            {INTEGRATIONS.map((it) => (
              <li key={it.id} data-integration={it.id}>
                <Link href={it.href} className="m-integration">
                  <Icon name={it.icon} size={20} />
                  <span className="m-integration-name">{it.name}</span>
                  <span className="m-integration-body">{it.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="m-section" aria-labelledby="security-title" data-section="security">
        <div className="m-wrap m-security">
          <div>
            <SectionHead
              id="security-title"
              eyebrow="Security & self-hosting"
              title="Your code, your server, your model"
              lede="OpenReview is a single Docker Compose stack: PostgreSQL with pgvector, Redis, the web app, and a worker. Nothing else is required but a model provider and a git host."
            />
            <ul className="m-checks">
              <li>
                <b>AGPL-3.0.</b> Read every line that touches your code, and run it unmodified or modified.
              </li>
              <li>
                <b>Offline bundle.</b> An enforced outbound allowlist and an internal network for the databases. No telemetry.
              </li>
              <li>
                <b>Bring your own model.</b> Anthropic, OpenAI, OpenRouter, or an OpenAI-compatible model on your own hardware.
              </li>
              <li>
                <b>SSO.</b> OIDC and SAML 2.0, allowed email domains, and SSO enforcement per organization.
              </li>
              <li>
                <b>Audit log.</b> Administrative actions and review events, filterable and exportable as CSV.
              </li>
              <li>
                <b>Untrusted input stays data.</b> Repository content and PR text are delimited in prompts and cannot change instructions or settings.
              </li>
            </ul>
          </div>
          <div className="m-terminal" role="group" aria-label="Self-hosting in three commands">
            <div className="m-terminal-bar" aria-hidden="true">
              <span className="hero-review-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
            <pre tabIndex={0}>
              <code>
                <span className="m-prompt">$</span> cp .env.example .env{"\n"}
                <span className="m-prompt">$</span> docker compose up -d{"\n"}
                <span className="m-prompt">$</span> docker compose ps{"\n"}
                <span className="m-term-dim">postgres, redis, app, worker: healthy</span>
              </code>
            </pre>
            <Link href="/docs/self-hosting" className="m-terminal-link">
              Self-hosting guide <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      <section className="m-section m-section-sunken" aria-labelledby="faq-title" data-section="faq">
        <div className="m-wrap m-faq-wrap">
          <SectionHead id="faq-title" eyebrow="FAQ" title="Questions" />
          <div className="m-faq">
            {LANDING_FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
            <p className="dim">
              More in the <Link href="/docs/faq">docs FAQ</Link>.
            </p>
          </div>
        </div>
      </section>

      <section className="m-final" aria-labelledby="final-title" data-section="cta">
        <div className="m-wrap m-final-inner">
          <h2 id="final-title" className="m-display">
            Put a reviewer on every pull request.
          </h2>
          <p className="m-lede">Install the GitHub App, or run it on your own server with Docker Compose.</p>
          <div className="m-cta-row">
            <Link href="/sign-in" className="button button-primary button-lg">
              Get started
            </Link>
            <Link href="/docs/quickstart" className="button button-lg">
              Read the quickstart
            </Link>
            {demoEnabled && (
              <Link href="/try" className="m-cta-link">
                Try it on a PR <span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
