import { test, before } from "node:test";
import assert from "node:assert/strict";
import { indexRepository } from "../src/engine/indexer";
import { loadGrammars } from "../src/engine/treesitter";
import { elixirUnderscore } from "../src/engine/graph-extract";
import { INDEX_GRAPH_VERSION } from "../src/engine/index-version";
import type { SourceFile } from "../src/engine/types";

const f = (path: string, content: string): SourceFile => ({ path, content, sha: "s" });
before(async () => { await loadGrammars(["x.ex"]); });

test("Elixir module names resolve to files by convention, including umbrella apps, multi-aliases and alias as:", () => {
  assert.deepEqual(["MyApp", "HTTPClient", "Accounts", "OAuth2Token", "JSON"].map(elixirUnderscore), ["my_app", "http_client", "accounts", "o_auth2_token", "json"]);
  const files = [
    f("apps/billing/lib/billing/invoice.ex", "defmodule Billing.Invoice do\n  def total(i), do: i\nend\n"),
    f("lib/my_app/http_client.ex", "defmodule MyApp.HTTPClient do\n  def get(url), do: url\nend\n"),
    f("lib/my_app/accounts/user.ex", "defmodule MyApp.Accounts.User do\n  def new, do: %{}\nend\n"),
    f("lib/my_app/accounts/token.ex", "defmodule MyApp.Accounts.Token do\n  def sign(t), do: t\nend\n"),
    f("lib/my_app/web.ex", [
      "defmodule MyApp.Web do",
      "  alias MyApp.Accounts.{User, Token}",
      "  alias MyApp.HTTPClient, as: Http",
      "  import Ecto.Query, only: [from: 2]",
      "  require Logger",
      "",
      "  def run(url) do",
      "    if is_binary(url), do: Logger.info(url)",
      "    Http.get(url) |> Token.sign()",
      "    User.new()",
      "    Billing.Invoice.total(1)",
      "    Enum.map([1], &(&1))",
      "    private_helper(url)",
      "  end",
      "",
      "  defp private_helper(x), do: x",
      "  defmacro wrap(x), do: x",
      "end",
    ].join("\n")),
  ];
  const index = indexRepository(files, files.map((x) => x.path));
  const edges = (kind: string) => index.relationships.filter((r) => r.from === "lib/my_app/web.ex" && r.kind === kind).map((r) => `${r.resolved ? "✓" : "✗"} ${r.symbol ?? ""}→${r.to}`).sort();
  assert.deepEqual(edges("imports"), ["✓ Http→lib/my_app/http_client.ex", "✓ Token→lib/my_app/accounts/token.ex", "✓ User→lib/my_app/accounts/user.ex", "✗ Logger→Logger", "✗ Query→Ecto.Query"].sort());
  assert.deepEqual(edges("calls"), ["✓ get→lib/my_app/http_client.ex", "✓ new→lib/my_app/accounts/user.ex", "✓ sign→lib/my_app/accounts/token.ex", "✓ total→apps/billing/lib/billing/invoice.ex", "✗ →Enum.map", "✗ →Logger.info"].sort());
  // Kernel forms and locally defined functions are not call edges; nothing points at itself.
  assert.ok(!index.relationships.some((r) => /^(if|is_binary|private_helper)$/.test(r.to)));
  assert.ok(index.relationships.every((r) => r.to !== r.from));
  const symbol = (name: string) => index.symbols.find((s) => s.path === "lib/my_app/web.ex" && s.name === name);
  assert.deepEqual([symbol("Web")?.kind, symbol("run")?.exported, symbol("private_helper")?.exported, symbol("wrap")?.kind], ["module", true, false, "macro"]);
});

test("stored graphs re-index after the Elixir extractor change", () => {
  assert.equal(INDEX_GRAPH_VERSION, 5);
  // Unparseable Elixir still indexes without throwing.
  const index = indexRepository([f("lib/broken.ex", "defmodule Broken do\n  def (\nend\n")], ["lib/broken.ex"]);
  assert.ok(Array.isArray(index.symbols));
});
