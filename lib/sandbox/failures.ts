/**
 * Failing test names recognized in test-runner output (R4.5): jest, vitest, pytest, and `go test`. Best effort —
 * unknown formats simply yield no names (the log tail is shown either way).
 */

const PATTERNS: RegExp[] = [
  // jest failure headers: "● Suite name › test name"
  /^\s*●\s+(.+?›.+?)\s*$/,
  // vitest: " FAIL  src/a.test.ts > suite > test" (the file-only line has no ">")
  /^\s*FAIL\s+(\S+\s+>\s+.+?)\s*$/,
  // jest / vitest per-test marks: "✕ test name (5 ms)", "× test name"
  /^\s*[✕×✗]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/,
  // pytest summary: "FAILED tests/test_x.py::test_y - AssertionError"
  /^\s*FAILED\s+(\S+::\S+)/,
  // pytest verbose: "tests/test_x.py::test_y FAILED"
  /^\s*(\S+::\S+)\s+FAILED\b/,
  // go test: "--- FAIL: TestName (0.00s)"
  /^\s*--- FAIL:\s+(\S+)/,
];

/** Distinct failing test names in `output`, in order of appearance, at most `max`. */
export function parseFailingTests(output: string, max = 20): string[] {
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    for (const re of PATTERNS) {
      const m = re.exec(line);
      const name = m?.[1]?.trim();
      if (name && name.length <= 300) {
        seen.add(name);
        break;
      }
    }
    if (seen.size >= max) break;
  }
  return [...seen];
}
