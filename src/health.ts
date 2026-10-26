// Daily health check against the live ABS and RBA APIs (run by .github/workflows/health.yml).
// Appends one line per run to health/log.jsonl, writes health/latest.md, and writes health/drift.txt
// when something broke, went stale or changed shape compared with the previous run.
//   npm run health
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { getCpi, getLabourForce, searchDataflows } from "./abs.js";
import { findDrift, type CheckResult, type Run } from "./health-core.js";
import { getCashRate, getExchangeRates, getLendingRates } from "./rba.js";
import type { Result } from "./series.js";

const checks: [string, () => Promise<Result | { results: unknown[] }>][] = [
  ["cpi", () => getCpi({ items: ["all_groups"], cities: ["australia"], measure: "annual_change" })],
  ["labour_force", () => getLabourForce({ measures: ["unemployment_rate"], states: ["australia"] })],
  ["cash_rate", () => getCashRate({ start: "2025-01" })],
  ["lending_rates", () => getLendingRates({ rates: ["owner_occupier_variable_discounted"], start: "2025-01" })],
  ["exchange_rates", () => getExchangeRates({ currencies: ["USD"], monthly: true, start: "2025-01" })],
  ["abs_search", async () => ({ results: await searchDataflows("wage price index") })],
];

const results: CheckResult[] = [];
for (const [id, fn] of checks) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    if ("series" in r) {
      const s = r.series[0];
      results.push({ id, ok: true, ms, series: r.series.length, latestPeriod: s?.latest?.period, latestValue: s?.latest?.value, notes: r.notes?.length ?? 0 });
    } else results.push({ id, ok: true, ms, series: r.results.length });
  } catch (e) {
    results.push({ id, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const run: Run = { at: new Date().toISOString(), version, checks: results };

mkdirSync("health", { recursive: true });
const logPath = "health/log.jsonl";
const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : [];
const previous = lines.length ? (JSON.parse(lines[lines.length - 1]) as Run) : undefined;
const drift = findDrift(run, previous);
appendFileSync(logPath, JSON.stringify(run) + "\n");

const md = [
  `# Health check`,
  ``,
  `Last run ${run.at} against aussie-data-mcp ${version}: ${results.filter((c) => c.ok).length}/${results.length} checks passed.`,
  ``,
  `| Check | OK | ms | Series | Latest |`,
  `| --- | --- | --- | --- | --- |`,
  ...results.map((c) => `| ${c.id} | ${c.ok ? "yes" : "NO"} | ${c.ms} | ${c.series ?? "-"} | ${c.latestPeriod ? `${c.latestPeriod} = ${c.latestValue}` : c.error ?? "-"} |`),
  ``,
  drift.length ? `## Needs attention\n\n${drift.map((d) => `- ${d}`).join("\n")}` : `Nothing changed shape since the previous run.`,
  ``,
  `Full history: health/log.jsonl (one line per run).`,
];
writeFileSync("health/latest.md", md.join("\n") + "\n");
if (drift.length) writeFileSync("health/drift.txt", drift.join("\n") + "\n");
console.log(md.join("\n"));
