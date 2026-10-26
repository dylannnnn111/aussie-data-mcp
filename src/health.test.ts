import assert from "node:assert/strict";
import { test } from "node:test";
import { findDrift, periodEnd, periodStart, type Run } from "./health-core.js";

const run = (at: string, checks: Run["checks"]): Run => ({ at, version: "0.2.1", checks });
const ok = (id: string, latestPeriod: string, series = 1, notes = 0) => ({ id, ok: true, ms: 100, series, latestPeriod, latestValue: 1, notes });

test("a healthy run after a healthy run reports nothing", () => {
  const a = run("2026-10-26T21:00:00Z", [ok("cpi", "2026-09"), ok("cash_rate", "2026-10")]);
  const b = run("2026-10-27T21:00:00Z", [ok("cpi", "2026-09"), ok("cash_rate", "2026-10")]);
  assert.deepEqual(findDrift(b, a), []);
});

test("failures, shape changes, stale data and missing checks are all reported", () => {
  const a = run("2026-10-26T21:00:00Z", [ok("cpi", "2026-09"), ok("cash_rate", "2026-10", 1), ok("lending_rates", "2026-09"), ok("abs_search", "", 5)]);
  const b = run("2026-10-27T21:00:00Z", [
    { id: "cpi", ok: false, ms: 30000, error: "timeout" },
    ok("cash_rate", "2026-10", 2, 1),
    ok("lending_rates", "2026-06"),
  ]);
  const d = findDrift(b, a).join("\n");
  assert.match(d, /cpi: failed - timeout/);
  assert.match(d, /cash_rate: series count changed from 1 to 2/);
  assert.match(d, /cash_rate: new note/);
  assert.match(d, /lending_rates: latest period went backwards/);
  assert.match(d, /lending_rates: latest period 2026-06 ended \d+ days ago/);
  assert.match(d, /abs_search: check missing/);
});

test("monthly data a few weeks after the month ends is not stale", () => {
  // 26 Oct 2026, latest CPI is August (ended 31 Aug, 56 days earlier): normal before the September release
  const a = run("2026-10-25T21:00:00Z", [ok("cpi", "2026-08")]);
  const b = run("2026-10-26T02:46:00Z", [ok("cpi", "2026-08")]);
  assert.deepEqual(findDrift(b, a), []);
});

test("periods parse", () => {
  assert.equal(periodEnd("2026-08")?.toISOString().slice(0, 10), "2026-08-31");
  assert.equal(periodEnd("2025-Q3")?.toISOString().slice(0, 10), "2025-09-30");
  assert.equal(periodStart("2026-09")?.toISOString().slice(0, 10), "2026-09-01");
  assert.equal(periodStart("2025-Q3")?.toISOString().slice(0, 10), "2025-07-01");
  assert.equal(periodStart("2026-09-30")?.toISOString().slice(0, 10), "2026-09-30");
});
