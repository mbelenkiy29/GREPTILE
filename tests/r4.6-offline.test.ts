import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { setLogSink } from "@/lib/log";
import { createOutboundFetch, hostAllowed, OutboundBlockedError, outboundPolicy } from "@/lib/net/fetch";

const ROOT = path.resolve(import.meta.dirname, "..");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Server-side source: everything under lib/, app/, worker/, and components/ except browser ("use client") modules. */
function serverSources(): { file: string; text: string }[] {
  return ["lib", "app", "worker", "components"]
    .flatMap((d) => files(path.join(ROOT, d)))
    .map((file) => ({ file: path.relative(ROOT, file), text: readFileSync(file, "utf8") }))
    .filter((s) => !/^\s*["']use client["']/.test(s.text));
}

const okTransport = (async () => new Response("ok")) as typeof fetch;

describe("offline self-host bundle", () => {
  test("R4.6 the outbound allowlist blocks unknown hosts when enforced and only logs them otherwise", async () => {
    const env = {
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "https://llm.internal.example:8443/v1",
      EMBEDDING_PROVIDER: "fake",
      GITHUB_API_URL: "https://ghe.example.com/api/v3",
      GITHUB_WEB_URL: "https://ghe.example.com",
      OUTBOUND_ALLOWLIST: "hooks.example.org, *.corp.example, https://alerts.example.net/x",
      OUTBOUND_ALLOWLIST_ENFORCE: "true",
    };
    const policy = outboundPolicy(env);
    expect(policy.enforce).toBe(true);
    expect(policy.hosts.sort()).toEqual(["*.corp.example", "alerts.example.net", "ghe.example.com", "hooks.example.org", "llm.internal.example:8443"].sort());
    expect(policy.reasons["llm.internal.example:8443"]).toBe("LLM endpoint");
    // Stripe only when billing is configured; default provider hosts when no base URL is set.
    expect(outboundPolicy({ ...env, STRIPE_SECRET_KEY: "set" }).hosts).toContain("api.stripe.com");
    expect(outboundPolicy({}).hosts).toEqual(expect.arrayContaining(["api.anthropic.com", "api.openai.com", "api.github.com", "github.com"]));
    expect(outboundPolicy({}).hosts).not.toContain("api.stripe.com");

    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
    try {
      const guarded = createOutboundFetch({ policy, transport: okTransport });
      await expect(guarded("https://ghe.example.com/api/v3/app")).resolves.toBeInstanceOf(Response);
      await expect(guarded("https://llm.internal.example:8443/v1/chat/completions", { method: "POST" })).resolves.toBeInstanceOf(Response);
      await expect(guarded("https://build.corp.example/hook")).resolves.toBeInstanceOf(Response);
      await expect(guarded("https://telemetry.example.com/collect")).rejects.toBeInstanceOf(OutboundBlockedError);
      // A port other than the allowed one is a different host.
      await expect(guarded("https://ghe.example.com:8080/")).rejects.toBeInstanceOf(OutboundBlockedError);
      await expect(guarded("https://llm.internal.example/v1")).rejects.toBeInstanceOf(OutboundBlockedError);
      expect(lines.some((l) => l.msg === "outbound request blocked by the allowlist" && l.host === "telemetry.example.com" && l.level === "error")).toBe(true);
      // Configured per-org endpoints are added by their callers.
      await expect(createOutboundFetch({ policy, transport: okTransport, allow: ["idp.acme.test"] })("https://idp.acme.test/.well-known/openid-configuration")).resolves.toBeInstanceOf(Response);

      const lenient = createOutboundFetch({ policy: { ...policy, enforce: false }, transport: okTransport });
      await expect(lenient("https://unlisted.example.com/")).resolves.toBeInstanceOf(Response);
      expect(lines.some((l) => l.level === "warn" && l.host === "unlisted.example.com")).toBe(true);
    } finally {
      restore();
    }
    expect(hostAllowed(new URL("http://a.example.com/"), ["a.example.com"])).toBe(true);
    expect(hostAllowed(new URL("https://example.com/"), ["*.example.com"])).toBe(false);
  });

  test("R4.6 every server-side outbound HTTP call site goes through the allowlisted fetch", () => {
    const sources = serverSources().filter((s) => s.file !== path.join("lib", "net", "fetch.ts"));
    // No bare global fetch: calls go to an injected transport or the allowlisted one.
    const bare = sources.filter((s) => /(^|[^\w.])fetch\s*\(|\?\?\s*fetch\b|globalThis\.fetch/m.test(s.text)).map((s) => s.file);
    expect(bare).toEqual([]);
    // SDK clients get the allowlisted fetch too.
    for (const s of sources.filter((x) => /new (Anthropic|OpenAI)\(/.test(x.text))) {
      expect(s.text, s.file).toMatch(/outboundFetch/);
    }
    // The known outbound call sites, each wired to the wrapper.
    const callSites = ["lib/auth/github-user.ts", "lib/github/client.ts", "lib/llm/openai.ts", "lib/llm/anthropic.ts", "lib/llm/gateway.ts", "lib/sso/net.ts"];
    for (const file of callSites) {
      expect(readFileSync(path.join(ROOT, file), "utf8"), file).toMatch(/(outboundFetch|createOutboundFetch)/);
    }
    // No web fonts, CDN scripts, or analytics in the UI.
    const ui = serverSources().concat(files(path.join(ROOT, "components")).map((f) => ({ file: f, text: readFileSync(f, "utf8") })));
    for (const s of ui) {
      expect(s.text, s.file).not.toMatch(/next\/font\/google|fonts\.googleapis|googletagmanager|cdn\.jsdelivr|unpkg\.com|<script\s+src=["']https?:/);
    }
  });

  test("R4.6 the offline compose override enforces the allowlist, disables telemetry, and isolates the databases", () => {
    const compose = readFileSync(path.join(ROOT, "docker-compose.offline.yml"), "utf8");
    expect(compose).toMatch(/OUTBOUND_ALLOWLIST_ENFORCE: "true"/);
    expect(compose).toMatch(/NEXT_TELEMETRY_DISABLED: "1"/);
    expect(compose).toMatch(/backend:\n\s+internal: true/);
    expect(readFileSync(path.join(ROOT, "Dockerfile"), "utf8")).toMatch(/ENV NEXT_TELEMETRY_DISABLED=1/);
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const v of ["OUTBOUND_ALLOWLIST", "OUTBOUND_ALLOWLIST_ENFORCE", "NEXT_TELEMETRY_DISABLED", "SSO_ALLOW_PRIVATE_ISSUERS", "AUDIT_RETENTION_DAYS"]) {
      expect(example).toMatch(new RegExp(`^${v}=`, "m"));
    }
    expect(readFileSync(path.join(ROOT, "docs/self-hosting.md"), "utf8")).toMatch(/docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d/);
  });
});
