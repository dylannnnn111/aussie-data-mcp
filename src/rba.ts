// Reserve Bank of Australia statistical tables (https://www.rba.gov.au/statistics/tables/). CSV, no key.
import { parseCsv } from "./csv.js";
import { fetchText } from "./http.js";
import { inRange, makeSeries, monthlyLast, Point, Result, Series, thin } from "./series.js";

export interface RbaColumn { id: string; title: string; description: string; unit: string; frequency: string; type: string; source: string; published: string }
export interface RbaTable { table: string; title: string; url: string; columns: RbaColumn[]; dates: string[]; values: (number | null)[][] }

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** RBA uses "31/08/2026" in some tables and "02-Oct-2026" in others. Returns YYYY-MM-DD or null. */
export function parseRbaDate(s: string): string | null {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
  return null;
}

export function tableUrl(table: string): string {
  return `https://www.rba.gov.au/statistics/tables/csv/${table.toLowerCase()}-data.csv`;
}

export function parseRbaTable(table: string, text: string): RbaTable {
  const rows = parseCsv(text);
  const meta = (label: string) => rows.find((r) => r[0]?.trim() === label)?.slice(1) ?? [];
  const ids = meta("Series ID");
  if (!ids.length) throw new Error(`RBA table ${table} didn't have the expected layout (no Series ID row).`);
  const titles = meta("Title"), desc = meta("Description"), units = meta("Units"), freq = meta("Frequency"),
    type = meta("Type"), src = meta("Source"), pub = meta("Publication date");
  const columns: RbaColumn[] = ids.map((id, i) => ({
    id: id.trim(), title: titles[i] ?? "", description: desc[i] ?? "", unit: units[i] ?? "",
    frequency: freq[i] ?? "", type: type[i] ?? "", source: src[i] ?? "", published: pub[i] ?? "",
  })).filter((c) => c.id);
  const dates: string[] = [];
  const values: (number | null)[][] = [];
  for (const r of rows) {
    const d = r[0] ? parseRbaDate(r[0]) : null;
    if (!d) continue;
    dates.push(d);
    values.push(columns.map((_, i) => {
      const v = r[i + 1]?.trim();
      return v ? Number(v) : null;
    }));
  }
  return { table: table.toUpperCase(), title: rows[0]?.[0]?.trim() ?? table, url: tableUrl(table), columns, dates, values };
}

export async function loadRbaTable(table: string): Promise<RbaTable> {
  const t = table.trim().toLowerCase();
  if (!/^[a-z]\d+(\.\d+)*$/.test(t)) throw new Error(`"${table}" doesn't look like an RBA table id (e.g. f1.1, f5, f6, f11.1, g1).`);
  return parseRbaTable(t, await fetchText(tableUrl(t)));
}

export function extractSeries(
  t: RbaTable,
  ids: string[],
  opts: { start?: string; end?: string; monthly?: boolean; names?: Record<string, string>; maxPoints?: number } = {},
): { series: Series[]; notes: string[] } {
  const notes: string[] = [];
  const series: Series[] = [];
  const thinned: string[] = [];
  for (const id of ids) {
    const i = t.columns.findIndex((c) => c.id.toUpperCase() === id.toUpperCase());
    if (i === -1) { notes.push(`Series ${id} isn't in RBA table ${t.table}.`); continue; }
    const col = t.columns[i];
    let pts: Point[] = [];
    t.dates.forEach((d, r) => {
      const v = t.values[r][i];
      if (v != null && Number.isFinite(v) && inRange(d, opts.start, opts.end)) pts.push([d, v]);
    });
    let freq = col.frequency;
    if (opts.monthly && /daily|weekly/i.test(freq)) { pts = monthlyLast(pts); freq = "Monthly (last observation in month)"; }
    const th = thin(pts, opts.maxPoints ?? 400);
    if (th.thinned) thinned.push(col.id);
    series.push(makeSeries(opts.names?.[col.id] ?? col.title, col.unit, freq, th.points));
  }
  if (thinned.length) notes.push(`${thinned.join(", ")} thinned to ${opts.maxPoints ?? 400} evenly spaced points (latest kept) - narrow the date range for full detail.`);
  return { series, notes };
}

// ---------- focused tools ----------

export async function getCashRate(a: { start?: string; end?: string }): Promise<Result> {
  const t = await loadRbaTable("f1.1");
  const { series, notes } = extractSeries(t, ["FIRMMCRT"], { ...a, names: { FIRMMCRT: "Cash rate target (monthly average)" } });
  notes.push("Monthly average of the RBA cash rate target. Periods are month-end dates.");
  return { source: "RBA F1.1 Interest Rates and Yields - Money Market", sourceUrl: t.url, series, notes };
}

export const LENDING_RATES = {
  owner_occupier_variable_standard: "FILRHLBVS",
  owner_occupier_variable_discounted: "FILRHLBVD",
  owner_occupier_3yr_fixed: "FILRHL3YF",
  investor_variable_standard: "FILRHLBVSI",
  investor_variable_discounted: "FILRHLBVDI",
  investor_3yr_fixed: "FILRHL3YFI",
  small_business_variable: "FILRSBVRT",
  credit_card_standard: "FILRPLRCCS",
  personal_loan_fixed: "FILRPLTUF",
} as const;

export async function getLendingRates(a: { rates: (keyof typeof LENDING_RATES)[]; start?: string; end?: string }): Promise<Result> {
  const t = await loadRbaTable("f5");
  const ids = a.rates.map((r) => LENDING_RATES[r]);
  const names = Object.fromEntries(t.columns.map((c) => [c.id, c.title.replace(/^Lending rates; /, "")]));
  const { series, notes } = extractSeries(t, ids, { start: a.start, end: a.end, names });
  notes.push("RBA indicator (advertised) rates from table F5, monthly. Rates actually paid on new loans are lower - see RBA table F6 via rba_series.");
  return { source: "RBA F5 Indicator Lending Rates", sourceUrl: t.url, series, notes };
}

export const CURRENCIES = ["USD", "TWI", "CNY", "JPY", "EUR", "KRW", "GBP", "SGD", "INR", "THB", "NZD", "TWD", "MYR", "IDR", "VND", "HKD", "CAD", "CHF", "PHP"] as const;

export async function getExchangeRates(a: { currencies: string[]; start?: string; end?: string; monthly?: boolean }): Promise<Result> {
  const t = await loadRbaTable("f11.1");
  // Map currency code to series by title ("A$1=USD", "Trade-weighted Index May 1970 = 100")
  const ids: string[] = [];
  const notes: string[] = [];
  for (const c of a.currencies) {
    const col = c.toUpperCase() === "TWI"
      ? t.columns.find((x) => /trade-weighted/i.test(x.title))
      : t.columns.find((x) => x.title.toUpperCase() === `A$1=${c.toUpperCase()}`);
    if (col) ids.push(col.id); else notes.push(`No RBA exchange rate series for ${c}.`);
  }
  const names = Object.fromEntries(t.columns.map((c) => [c.id, /trade-weighted/i.test(c.title) ? "AUD trade-weighted index (May 1970 = 100)" : `AUD/${c.title.split("=")[1]} (units of foreign currency per A$1)`]));
  const r = extractSeries(t, ids, { start: a.start, end: a.end, monthly: a.monthly ?? true, names });
  notes.push(...r.notes, "This table covers 2023 to now. Older history is in RBA table f11.1 archives (not wired in).");
  return { source: "RBA F11.1 Exchange Rates (4pm AEST)", sourceUrl: t.url, series: r.series, notes };
}

export async function rbaSeries(a: { table: string; series?: string[]; search?: string; start?: string; end?: string; monthly?: boolean }): Promise<Result | { table: string; title: string; columns: Pick<RbaColumn, "id" | "title" | "unit" | "frequency">[] }> {
  const t = await loadRbaTable(a.table);
  let ids = a.series ?? [];
  if (!ids.length && a.search) {
    const terms = a.search.toLowerCase().split(/\s+/);
    ids = t.columns.filter((c) => terms.every((w) => `${c.title} ${c.description}`.toLowerCase().includes(w))).map((c) => c.id).slice(0, 8);
  }
  if (!ids.length) {
    // No series picked: return the menu so the model can choose
    return { table: t.table, title: t.title, columns: t.columns.map(({ id, title, unit, frequency }) => ({ id, title, unit, frequency })) };
  }
  const { series, notes } = extractSeries(t, ids, { start: a.start, end: a.end, monthly: a.monthly });
  return { source: `RBA ${t.table} ${t.title}`, sourceUrl: t.url, series, notes };
}
