import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import DocPage, { generateStaticParams } from "@/app/(marketing)/docs/[[...slug]]/page";
import { GET as searchIndexRoute } from "@/app/(marketing)/docs/search.json/route";
import {
  buildSearchIndex,
  contentSlugs,
  headingsOf,
  loadDoc,
  parseFrontmatter,
  prepareInclude,
  resolveIncludedLink,
  segmentsOf,
  Slugger,
} from "@/lib/docs/content";
import {
  apiReferenceMarkdown,
  apiRouteIds,
  configKeys,
  configReferenceMarkdown,
  CONFIG_KEY_DOCS,
  ENV_SECTION_STARTS,
  envExampleVars,
  envReferenceMarkdown,
  modesReferenceMarkdown,
  parseEnvExample,
  RUNTIME_VALIDATION_DOCS,
  configJsonSchema,
} from "@/lib/docs/generated";
import { DOC_SLUGS, DOCS_NAV, docHref, neighbours, slugFromParams } from "@/lib/docs/nav";
import { renderDoc } from "@/lib/docs/render";
import { searchDocs, terms } from "@/lib/docs/search";
import { openApiDocument } from "@/lib/api/openapi";
import { repoConfigSchema } from "@/lib/config/repo-config";
import { MODE_PROFILES } from "@/lib/engine/modes";

const root = path.resolve(import.meta.dirname, "..");

const renderPage = async (slug: string) => renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: slug === "index" ? [] : [slug] }) }));

/** Table rows `| `KEY` | ...` → KEY, for one generated Markdown table. */
const firstColumnCodes = (md: string) => [...md.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);

describe("docs site", () => {
  test("R5.3 navigation covers every content file exactly once, with the required pages", () => {
    expect([...DOC_SLUGS].sort()).toEqual(contentSlugs());
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
    for (const required of [
      "index",
      "quickstart",
      "github-app",
      "gitlab",
      "bitbucket",
      "configuration",
      "review-modes",
      "rules",
      "learning",
      "knowledge-base",
      "conversations",
      "cli",
      "mcp",
      "api",
      "self-hosting",
      "sso",
      "security",
      "troubleshooting",
      "faq",
    ]) {
      expect(DOC_SLUGS).toContain(required);
    }
    expect(generateStaticParams()).toHaveLength(DOC_SLUGS.length);
    expect(slugFromParams(undefined)).toBe("index");
    expect(slugFromParams(["cli"])).toBe("cli");
    expect(slugFromParams(["index"])).toBeNull();
    expect(slugFromParams(["nope"])).toBeNull();
    expect(slugFromParams(["cli", "x"])).toBeNull();
    expect(neighbours("index")).toEqual({ prev: null, next: "quickstart" });
    expect(neighbours(DOC_SLUGS.at(-1)!).next).toBeNull();
    expect(DOCS_NAV.every((s) => s.slugs.length > 0)).toBe(true);
  });

  test("R5.3 every doc page renders with its title, sidebar, prev/next links, and a table of contents", async () => {
    for (const slug of DOC_SLUGS) {
      const page = loadDoc(slug);
      const html = await renderPage(slug);
      expect(html, slug).toContain(`<h1 id="doc-title">${page.title.replace(/&/g, "&amp;")}</h1>`);
      expect(html, slug).toContain('aria-current="page"');
      expect(html, slug).toContain('aria-label="Documentation"');
      const { prev, next } = neighbours(slug);
      if (prev) expect(html, slug).toContain(`href="${docHref(prev)}"`);
      if (next) expect(html, slug).toContain(`href="${docHref(next)}"`);
      const { toc } = await renderDoc(page);
      for (const t of toc) expect(html, `${slug}#${t.id}`).toContain(`id="${t.id}"`);
      // No unrendered directives or raw MDX comments leak into the output.
      expect(html, slug).not.toMatch(/@include|@generated|\{\/\*/);
    }
  });

  test("R5.3 code blocks get a copy button and a language label", async () => {
    const html = await renderPage("quickstart");
    expect(html).toContain('class="doc-code"');
    expect(html).toMatch(/<figcaption class="doc-code-head"><span>sh<\/span>/);
    expect(html).toContain('aria-label="Copy code"');
  });

  test("R5.3 the openreview.json reference lists exactly the zod schema's keys, each documented", async () => {
    const keys = Object.keys(repoConfigSchema.shape);
    expect([...configKeys()].sort()).toEqual([...keys].sort());
    expect(Object.keys(CONFIG_KEY_DOCS).sort()).toEqual([...keys].sort());
    const rvKeys = Object.keys(configJsonSchema().properties!.runtimeValidation!.properties!);
    expect(Object.keys(RUNTIME_VALIDATION_DOCS).sort()).toEqual([...rvKeys].sort());

    const md = configReferenceMarkdown();
    const [main, rv] = md.split("## runtimeValidation");
    expect(firstColumnCodes(main!)).toEqual(keys);
    expect(firstColumnCodes(rv!.split("## Example")[0]!)).toEqual(rvKeys);
    // Enum values come from the schema.
    expect(md).toContain('"fast" \\| "standard" \\| "deep"');
    // The example in the reference is itself a valid openreview.json.
    const example = /```json\n([\s\S]*?)\n```/.exec(md)![1]!;
    expect(repoConfigSchema.safeParse(JSON.parse(example)).success).toBe(true);

    const html = await renderPage("configuration");
    for (const k of keys) expect(html).toContain(`<code>${k}</code>`);
  });

  test("R5.3 the environment variable table matches .env.example", async () => {
    const text = readFileSync(path.join(root, ".env.example"), "utf8");
    const expected = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    const vars = envExampleVars(root);
    expect(vars.map((v) => v.name)).toEqual(expected);
    expect(firstColumnCodes(envReferenceMarkdown(root)).sort()).toEqual([...expected].sort());
    for (const start of Object.keys(ENV_SECTION_STARTS)) expect(expected, `section start ${start}`).toContain(start);
    const html = await renderPage("self-hosting");
    for (const name of expected) expect(html, name).toContain(`<code>${name}</code>`);
  });

  test("R5.3 the env parser keeps descriptions and sections", () => {
    const vars = parseEnvExample("# Runtime\nNODE_ENV=development\n# The public URL\n# of the app\nAPP_URL=http://x\n\n# Redis (BullMQ). Compose overrides it.\nREDIS_URL=redis://r\nOTHER=1\n");
    expect(vars).toEqual([
      { name: "NODE_ENV", example: "development", description: "", section: "Runtime" },
      { name: "APP_URL", example: "http://x", description: "The public URL of the app", section: "Runtime" },
      { name: "REDIS_URL", example: "redis://r", description: "Redis (BullMQ). Compose overrides it.", section: "Redis" },
      { name: "OTHER", example: "1", description: "", section: "Redis" },
    ]);
  });

  test("R5.3 the REST API reference lists every route in the OpenAPI document", async () => {
    const doc = openApiDocument("https://x.example") as { paths: Record<string, Record<string, unknown>> };
    const expected = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`));
    expect(apiRouteIds().sort()).toEqual(expected.sort());
    const md = apiReferenceMarkdown();
    for (const id of expected) expect(md).toContain(`### ${id}`);
    const html = await renderPage("api");
    for (const id of expected) expect(html, id).toContain(id.replace("{", "{").replace(/&/g, "&amp;"));
  });

  test("R5.3 the review modes table comes from MODE_PROFILES and creditsFor", () => {
    const md = modesReferenceMarkdown({ CREDITS_FAST: "7" });
    expect(md).toContain("| Credits per review (default) | 7 | 2 | 4 |");
    expect(md).toContain(`| Specialized reviewers | ${MODE_PROFILES.fast.maxAgents} | ${MODE_PROFILES.standard.maxAgents} | all |`);
  });

  test("R5.3 included repository docs are rendered with shifted headings and rewritten links", async () => {
    const md = prepareInclude("docs/mcp.md", "# Title\n\nSee [CLI](../packages/cli/README.md) and [loop](../integrations/loop/run.sh#x).\n\n## Section\n\n```md\n# not a heading\n```\n", "https://git.example/o/r");
    expect(md).not.toContain("# Title");
    expect(md).toContain("### Section");
    expect(md).toContain("# not a heading");
    expect(md).toContain("[CLI](/docs/cli)");
    expect(md).toContain("[loop](https://git.example/o/r/blob/main/integrations/loop/run.sh#x)");
    expect(resolveIncludedLink("docs/a.md", "https://e.x", "https://g")).toBe("https://e.x");
    expect(() => segmentsOf("{/* @include ../etc/passwd */}", root)).toThrow(/inside the repository/);
    expect(() => segmentsOf("{/* @generated nope */}", root)).toThrow(/unknown generator/);
    const cli = await renderPage("cli");
    expect(cli).toContain("openreview login");
    const mcp = await renderPage("mcp");
    expect(mcp).not.toMatch(/href="\.\.\//);
  });

  test("R5.3 frontmatter is validated and heading ids are unique", () => {
    expect(() => parseFrontmatter("no frontmatter")).toThrow(/missing frontmatter/);
    expect(() => parseFrontmatter("---\ntitle: X\n---\nbody")).toThrow(/description/);
    expect(parseFrontmatter("---\ntitle: X\ndescription: Y\n---\nbody").body).toBe("body");
    const s = new Slugger();
    expect([s.slug("Install"), s.slug("Install"), s.slug("`openreview login` (CLI)")]).toEqual(["install", "install-1", "openreview-login-cli"]);
  });

  test("R5.3 the search index includes every page and finds pages by title, heading, and text", async () => {
    const index = buildSearchIndex(root);
    expect(index.map((e) => e.slug)).toEqual([...DOC_SLUGS]);
    for (const e of index) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.text.length).toBeGreaterThan(100);
    }
    expect(headingsOf(loadDoc("sso"))).toEqual(expect.arrayContaining([{ depth: 2, text: "SAML 2.0" }]));
    expect(searchDocs(index, "saml")[0]?.href).toBe("/docs/sso");
    expect(searchDocs(index, "openreview.json")[0]?.href).toBe("/docs/configuration");
    expect(searchDocs(index, "OUTBOUND_ALLOWLIST_ENFORCE").map((h) => h.href)).toContain("/docs/self-hosting");
    expect(searchDocs(index, "x")).toEqual([]);
    expect(searchDocs(index, "zzzz-no-such-word")).toEqual([]);
    expect(terms("  SAML, sso! ")).toEqual(["saml", "sso"]);

    const res = searchIndexRoute();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as unknown[]).length).toBe(DOC_SLUGS.length);
  });
});
