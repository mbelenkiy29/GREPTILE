import { test } from "node:test";
import assert from "node:assert/strict";
import { chartScale, linePoints, segments } from "../src/charts";

test("chart geometry: shared zero-based scale, padded points, gaps split lines", () => {
  assert.equal(chartScale([{ label: "a", values: [1, 5, null] }, { label: "b", values: [3, Number.NaN] }]), 5);
  assert.equal(chartScale([{ label: "a", values: [0, 0] }]), 1, "flat zero series still has a scale");
  assert.deepEqual(linePoints([0, 5, 10], 10, 104, 104), ["4.0,100.0", "52.0,52.0", "100.0,4.0"]);
  assert.deepEqual(linePoints([7], 10, 104, 104), ["52.0,32.8"], "a single point is centred");
  assert.deepEqual(linePoints([-3], 10, 104, 104), ["52.0,100.0"], "negative values clamp to the baseline");
  assert.deepEqual(segments(["1,1", "2,2", null, "4,4", null, null, "6,6", "7,7"]), ["1,1 2,2", "4,4", "6,6 7,7"]);
  assert.deepEqual(segments([null, null]), []);
});
