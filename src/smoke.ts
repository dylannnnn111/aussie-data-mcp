// Calls every data function against the live APIs and prints a one-line summary each.
// Run: npm run smoke
import { describeDataflow, getCpi, getLabourForce, searchDataflows } from "./abs.js";
import { getCommutePulse } from "./commute.js";
import { getCashRate, getExchangeRates, getLendingRates, rbaSeries } from "./rba.js";
import type { Result } from "./series.js";

const show = (label: string, r: Result | unknown) => {
  const res = r as Result;
  if (!res.series) { console.log(`OK  ${label}:`, JSON.stringify(r).slice(0, 300)); return; }
  console.log(`${res.series.length ? "OK " : "!! "} ${label}: ${res.series.length} series`);
  for (const s of res.series.slice(0, 4))
    console.log(`      ${s.name} [${s.unit}] ${s.points.length} pts  ${s.start?.period}=${s.start?.value} -> ${s.latest?.period}=${s.latest?.value}`);
  if (res.notes?.length) console.log(`      notes: ${res.notes.join(" | ").slice(0, 200)}`);
};

const checks: [string, () => Promise<unknown>][] = [
  ["CPI headline, Australia, annual", () => getCpi({ items: ["all_groups"], cities: ["australia"], measure: "annual_change" })],
  ["CPI full history depth (index)", () => getCpi({ items: ["all_groups"], cities: ["australia"], measure: "index" })],
  ["CPI rents, Sydney + Australia, annual, since 2019 (adds quarterly)", () => getCpi({ items: ["rents"], cities: ["sydney", "australia"], measure: "annual_change", start: "2019-01" })],
  ["CPI trimmed mean (SA fallback)", () => getCpi({ items: ["trimmed_mean"], cities: ["australia"], measure: "annual_change", start: "2024-01" })],
  ["Unemployment, AUS + NSW, SA", () => getLabourForce({ measures: ["unemployment_rate"], states: ["australia", "nsw"], start: "2022-01" })],
  ["Cash rate since 2022", () => getCashRate({ start: "2022-01" })],
  ["Lending rates", () => getLendingRates({ rates: ["owner_occupier_variable_discounted", "investor_3yr_fixed"], start: "2022-01" })],
  ["AUD/USD + TWI monthly", () => getExchangeRates({ currencies: ["USD", "TWI"], monthly: true })],
  ["RBA f6 menu", () => rbaSeries({ table: "f6" })],
  ["RBA g1 search", () => rbaSeries({ table: "g1", search: "inflation" })],
  ["Commute Pulse Friday gap", () => getCommutePulse({ view: "friday_gap", centres: ["Sydney CBD", "North Sydney"], start: "2025-01" })],
  ["Commute Pulse suburban", () => getCommutePulse({ view: "suburban_morning" })],
  ["ABS search 'wage price index'", async () => ({ results: await searchDataflows("wage price index") })],
  ["ABS describe WPI", async () => { const d = await describeDataflow("WPI", 5); return d.dimensions.map((x) => `${x.id}(${x.totalCodes})`).join(" . "); }],
];

let failed = 0;
for (const [label, fn] of checks) {
  const t0 = Date.now();
  try { const r = await fn(); show(`${label} (${Date.now() - t0}ms)`, r); }
  catch (e) { failed++; console.log(`!!  ${label}: ${e instanceof Error ? e.message : e}`); }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks ran");
process.exit(failed ? 1 : 0);
