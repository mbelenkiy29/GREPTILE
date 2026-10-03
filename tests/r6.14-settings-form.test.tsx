import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SettingsFields } from "@/components/dashboard/SettingsFields";
import { parseSettingsForm, saveRepoSettingsForm } from "@/lib/config/settings-form";
import { resolveEffectiveSettings } from "@/lib/config/settings";
import { getRepo } from "@/lib/data/installations";
import { getRepoSettingsView, updateOrgSettings } from "@/lib/data/settings";
import { dashboardFixture } from "./helpers/dashboard";
import { FakeGitHost } from "./helpers/fake-git";

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe("repository settings UI (R6.14)", () => {
  test("R6.14 settings form shows each value's source badge", () => {
    const org = { maxComments: 5, reviewDrafts: true };
    const repo = { mode: "deep" as const, strictness: "high" as const };
    const file = { autoReview: false };
    const { settings, sources } = resolveEffectiveSettings(org, repo, file);
    const inherited = resolveEffectiveSettings(org, undefined, undefined).settings;
    const html = renderToStaticMarkup(<SettingsFields settings={settings} sources={sources} inherited={inherited} repoSettings={repo} />);
    const badge = (key: string, source: string) =>
      new RegExp(`data-field="setting-${key}".*?data-source="${source}"`, "s").test(html.slice(html.indexOf(`data-field="setting-${key}"`)));
    expect(badge("autoReview", "file")).toBe(true);
    expect(badge("reviewDrafts", "org")).toBe(true);
    expect(badge("maxComments", "org")).toBe(true);
    expect(badge("mode", "repo")).toBe(true);
    expect(badge("minConfidence", "strictness")).toBe(true);
    expect(badge("commentStyle", "default")).toBe(true);
    expect(badge("categories", "default")).toBe(true);
    expect(html).toContain("openreview.json");
    // Inherit options name what applies when the repo leaves a key unset.
    expect(html).toContain("Inherit (On)");
    expect(html).toContain('placeholder="Inherit (5)"');
    // Every R6.14 setting has a control.
    for (const name of [
      "autoReview",
      "reviewDrafts",
      "targetBranches",
      "ignoredBranches",
      "ignore",
      "maxComments",
      "minConfidence",
      "minSeverity",
      "categories",
      "model",
      "mode",
      "customInstructions",
      "autoReReview",
      "commentStyle",
      "strictness",
      "context",
    ]) {
      expect(html, name).toContain(`name="${name}"`);
    }
  });

  test("R6.14 saving settings through the action wrapper validates, persists, and enforces the role", async () => {
    const fx = await dashboardFixture();
    const repoId = String(fx.repos.web.id);
    const valid = form([
      ["repoId", repoId],
      ["autoReview", "false"],
      ["reviewDrafts", ""],
      ["targetBranches", "main\n release/* \n"],
      ["maxComments", "7"],
      ["minConfidence", "0.65"],
      ["minSeverity", "high"],
      ["categoriesMode", "custom"],
      ["categories", "security"],
      ["categories", "correctness"],
      ["mode", "fast"],
      ["model", " model-x "],
      ["customInstructions", "Prices are integer cents."],
      ["commentStyle", "detailed"],
    ]);

    expect(await saveRepoSettingsForm(fx.db, { orgId: "org_a", role: "member" }, valid)).toMatchObject({ status: "forbidden" });
    expect((await getRepo(fx.db, "org_a", fx.repos.web.id))!.settings).toEqual({});

    // Another org's admin cannot write org A's repository.
    expect(await saveRepoSettingsForm(fx.db, { orgId: "org_b", role: "owner" }, valid)).toMatchObject({ status: "not_found" });

    const saved = await saveRepoSettingsForm(fx.db, { orgId: "org_a", role: "admin" }, valid);
    expect(saved).toEqual({ status: "saved", errors: {}, message: "Settings saved." });
    expect((await getRepo(fx.db, "org_a", fx.repos.web.id))!.settings).toEqual({
      autoReview: false,
      targetBranches: ["main", "release/*"],
      maxComments: 7,
      minConfidence: 0.65,
      minSeverity: "high",
      categories: ["security", "correctness"],
      mode: "fast",
      model: "model-x",
      customInstructions: "Prices are integer cents.",
      commentStyle: "detailed",
    });

    const invalid = await saveRepoSettingsForm(
      fx.db,
      { orgId: "org_a", role: "owner" },
      form([
        ["repoId", repoId],
        ["maxComments", "500"],
        ["minConfidence", "abc"],
        ["categoriesMode", "custom"],
        ["mode", "turbo"],
      ]),
    );
    expect(invalid.status).toBe("invalid");
    expect(invalid.errors).toMatchObject({
      maxComments: "Enter a whole number from 0 to 100.",
      minConfidence: "Enter a number from 0 to 1, e.g. 0.6.",
      categories: expect.stringContaining("Choose at least one category"),
    });
    expect(invalid.errors.mode).toBeTruthy();
    expect(invalid.values).toMatchObject({ maxComments: "500", mode: "turbo", categories: [] });
    // Nothing was written by the invalid submission.
    expect((await getRepo(fx.db, "org_a", fx.repos.web.id))!.settings.maxComments).toBe(7);

    // Clearing every field returns the repository to inheriting all settings.
    expect(await saveRepoSettingsForm(fx.db, { orgId: "org_a", role: "admin" }, form([["repoId", repoId], ["categoriesMode", "inherit"]]))).toMatchObject({ status: "saved" });
    expect((await getRepo(fx.db, "org_a", fx.repos.web.id))!.settings).toEqual({});
    expect(parseSettingsForm(form([["autoReview", "maybe"]])).errors?.autoReview).toBeTruthy();
  });

  test("R6.14 settings view reads openreview.json and marks file-provided values", async () => {
    const fx = await dashboardFixture();
    await updateOrgSettings(fx.db, "org_a", { commentStyle: "detailed" });
    const host = new FakeGitHost();
    host.contentAt = (repo, path, ref) => (repo === "acme/api" && path === "openreview.json" && ref === "main" ? JSON.stringify({ maxComments: 3, rules: ["Use cents"] }) : null);
    const view = (await getRepoSettingsView(fx.db, "org_a", fx.repos.api.id, { host }))!;
    expect(view.file).toEqual({ status: "found", message: null, settings: { maxComments: 3 } });
    expect(view.sources).toMatchObject({ maxComments: "file", mode: "repo", commentStyle: "org", autoReview: "default" });
    expect(view.settings.maxComments).toBe(3);

    host.contentAt = () => "{ not json";
    expect((await getRepoSettingsView(fx.db, "org_a", fx.repos.api.id, { host }))!.file.status).toBe("invalid");
    host.contentAt = () => {
      throw new Error("GitHub 503");
    };
    const down = (await getRepoSettingsView(fx.db, "org_a", fx.repos.api.id, { host }))!;
    expect(down.file).toMatchObject({ status: "unavailable", message: "Couldn't read openreview.json: GitHub 503" });
    expect(down.sources.maxComments).toBe("default");
    expect((await getRepoSettingsView(fx.db, "org_a", fx.repos.api.id))!.file.status).toBe("not_checked");
    expect(await getRepoSettingsView(fx.db, "org_b", fx.repos.api.id, { host })).toBeUndefined();
  });
});
