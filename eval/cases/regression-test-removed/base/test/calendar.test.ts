import assert from "node:assert/strict";
import { test } from "node:test";
import { daysInMonth, isLeapYear } from "../src/dates/calendar";

test("daysInMonth knows short months", () => {
  assert.equal(daysInMonth(2023, 4), 30);
  assert.equal(daysInMonth(2023, 1), 31);
});

test("regression #212: centuries are leap years only when divisible by 400", () => {
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(daysInMonth(1900, 2), 28);
});
