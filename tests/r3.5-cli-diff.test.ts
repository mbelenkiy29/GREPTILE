import { describe, expect, test } from "vitest";
import { changeReader, reconstructBase, removedContent } from "@/lib/review/local";
import { parseRemote } from "@/packages/cli/src/git";
import { patchBetween } from "./helpers/engine";

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

describe("CLI review inputs (R3.5)", () => {
  test("R3.5 the server rebuilds base versions from head contents and git's unified diff, for every hunk shape", () => {
    const base = lines(40);
    const cases: [string, string, string][] = [
      ["edit in the middle", base, base.replace("line 20\n", "line twenty\nextra\n")],
      ["several hunks", base, base.replace("line 2\n", "").replace("line 30\n", "LINE 30\n").replace("line 39\n", "line 39\nappended\n")],
      ["insert at the top", base, `header\n${base}`],
      ["delete at the end", base, lines(35)],
      ["remove the final newline", base, base.slice(0, -1)],
      ["add a final newline", base.slice(0, -1), base],
      ["no final newline on either side", "a\nb\nc", "a\nB\nc"],
      ["whole file rewritten", "x\ny\n", "p\nq\nr\n"],
      ["blank lines in context", "a\n\n\nb\nc\n", "a\n\n\nB\nc\n"],
    ];
    for (const [name, before, after] of cases) {
      const patch = patchBetween(before, after);
      expect(reconstructBase(after, patch), name).toBe(before);
    }
    // A diff that does not fit the head content (stale or cut) is refused rather than guessed at.
    expect(reconstructBase(base.replace("line 20", "changed later"), patchBetween(base, base.replace("line 20\n", "line twenty\n")))).toBeNull();
    expect(removedContent(patchBetween("gone\nfile\n", null))).toBe("gone\nfile\n");
  });

  test("R3.5 changeReader serves head contents as sent and base contents per file status (added, removed, renamed)", async () => {
    const read = changeReader(
      [
        { path: "src/new.ts", status: "added", patch: patchBetween(null, "export const n = 1;\n") },
        { path: "src/old.ts", status: "removed", patch: patchBetween("export const o = 1;\n", null) },
        { path: "src/b.ts", previousPath: "src/a.ts", status: "renamed", patch: patchBetween("export const a = 1;\n", "export const a = 2;\n") },
        { path: "src/big.ts", status: "modified", patch: patchBetween("1\n", "2\n") },
      ],
      { "src/new.ts": "export const n = 1;\n", "src/b.ts": "export const a = 2;\n" },
    );
    expect(await read("src/new.ts", "head")).toBe("export const n = 1;\n");
    expect(await read("src/new.ts", "base")).toBeNull();
    expect(await read("src/old.ts", "base")).toBe("export const o = 1;\n");
    expect(await read("src/old.ts", "head")).toBeNull();
    expect(await read("src/a.ts", "base")).toBe("export const a = 1;\n");
    // A file sent without content (over the size limit) has neither version; the engine reviews its diff only.
    expect(await read("src/big.ts", "base")).toBeNull();
    expect(await read("src/unknown.ts", "base")).toBeNull();
  });

  test("R3.5 the CLI finds owner/name from https, ssh, and scp-style remotes", () => {
    expect(parseRemote("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(parseRemote("https://token@github.com/acme/shop")).toBe("acme/shop");
    expect(parseRemote("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(parseRemote("ssh://git@github.example.com:2222/acme/shop.git")).toBe("acme/shop");
    expect(parseRemote("https://gitlab.com/group/sub/shop.git")).toBe("group/sub/shop");
    expect(parseRemote("/srv/git/shop")).toBeNull();
  });
});
