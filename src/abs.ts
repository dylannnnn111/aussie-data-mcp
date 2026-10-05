// Australian Bureau of Statistics - SDMX Data API (https://data.api.abs.gov.au). No key needed.
import { parseCsvObjects } from "./csv.js";
import { fetchText, UpstreamError } from "./http.js";
import { makeSeries, Point, Result, Series, thin } from "./series.js";

const BASE = "https://data.api.abs.gov.au/rest";
const CSV = { Accept: "application/vnd.sdmx.data+csv;labels=both" };
const XML = { Accept: "application/vnd.sdmx.structure+xml;version=2.1" };

// ---------- generic data fetch ----------

/** "3: Percentage change from previous year" -> { code: "3", label: "Percentage change from previous year" } */
function splitCode(v: string): { code: string; label: string } {
  const i = v.indexOf(": ");
  return i === -1 ? { code: v, label: v } : { code: v.slice(0, i), label: v.slice(i + 2) };
}

const NON_DIM = new Set(["DATAFLOW", "TIME_PERIOD", "OBS_VALUE", "UNIT_MEASURE", "UNIT_MULT", "OBS_STATUS", "OBS_COMMENT", "DECIMALS", "BASE_PERIOD"]);
const colId = (h: string) => h.split(":")[0].trim();
// Dimensions that describe how a series is measured rather than what it is - kept out of names when shared
const QUALIFIERS = new Set(["MEASURE", "TSEST", "AGE", "SEX", "FREQ"]);

export interface AbsQuery {
  dataflow: string; // e.g. "CPI" or "ABS,CPI,2.0.0"
  key: string; // SDMX key, dimensions joined by ".", "+" for multiple, empty for all
  startPeriod?: string;
  endPeriod?: string;
  lastN?: number;
}

export interface AbsRawSeries {
  dims: Record<string, { code: string; label: string }>;
  unit: string;
  frequency: string;
  points: Point[];
}

export function absDataUrl(q: AbsQuery): string {
  const flow = q.dataflow.includes(",") ? q.dataflow : `ABS,${q.dataflow}`;
  const params = new URLSearchParams();
  if (q.startPeriod) params.set("startPeriod", q.startPeriod);
  if (q.endPeriod) params.set("endPeriod", q.endPeriod);
  if (q.lastN) params.set("lastNObservations", String(q.lastN));
  const qs = params.toString();
  return `${BASE}/data/${flow}/${q.key || "all"}${qs ? "?" + qs : ""}`;
}

export async function absFetch(q: AbsQuery): Promise<AbsRawSeries[]> {
  const url = absDataUrl(q);
  let text: string;
  try {
    text = await fetchText(url, CSV);
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) return []; // ABS answers "NoResultsFound" with 404
    if (e instanceof UpstreamError && e.status === 400)
      throw new Error(`ABS rejected the query (bad dataflow id or key). Check the key against abs_describe_dataflow. ${e.body ?? ""}`.trim());
    throw e;
  }
  const rows = parseCsvObjects(text);
  const groups = new Map<string, AbsRawSeries>();
  for (const r of rows) {
    const dims: AbsRawSeries["dims"] = {};
    let unit = "", mult = "", freq = "";
    for (const [h, v] of Object.entries(r)) {
      const id = colId(h);
      if (id === "UNIT_MEASURE") unit = splitCode(v).label;
      else if (id === "UNIT_MULT") mult = splitCode(v).label;
      else if (id === "FREQ") freq = splitCode(v).label;
      if (!NON_DIM.has(id) && id !== "FREQ" && v) dims[id] = splitCode(v);
    }
    const sk = Object.values(dims).map((d) => d.code).join(".");
    let g = groups.get(sk);
    if (!g) {
      const u = mult && mult !== "Units" && mult !== "One" ? `${unit} (${mult})` : unit;
      g = { dims, unit: u, frequency: freq, points: [] };
      groups.set(sk, g);
    }
    const value = Number(r[Object.keys(r).find((h) => colId(h) === "OBS_VALUE")!]);
    const period = r[Object.keys(r).find((h) => colId(h) === "TIME_PERIOD")!];
    if (period && Number.isFinite(value)) g.points.push([period, value]);
  }
  return [...groups.values()];
}

/** Name each series by the dimensions that differ between series; list the shared ones once as notes. */
export function nameSeries(raw: AbsRawSeries[], maxPoints = 400): { series: Series[]; notes: string[] } {
  const ids = [...new Set(raw.flatMap((s) => Object.keys(s.dims)))];
  const varying = ids.filter((id) => new Set(raw.map((s) => s.dims[id]?.code)).size > 1);
  const shared = ids.filter((id) => !varying.includes(id) && raw[0]?.dims[id]);
  const notes: string[] = [];
  if (shared.length) notes.push("All series: " + shared.map((id) => raw[0].dims[id].label).join(", "));
  let anyThinned = false;
  const series = raw.map((s) => {
    const nameDims = varying.length ? varying : ids.filter((id) => !QUALIFIERS.has(id));
    const name = (nameDims.length ? nameDims : ids).map((id) => s.dims[id]?.label).filter(Boolean).join(" - ");
    const t = thin(s.points, maxPoints);
    anyThinned ||= t.thinned;
    return makeSeries(name, s.unit, s.frequency, t.points);
  });
  if (anyThinned) notes.push(`Long series were thinned to ${maxPoints} evenly spaced points (latest kept). Narrow the date range for full detail.`);
  return { series, notes };
}

// ---------- CPI ----------

export const CPI_ITEMS = {
  all_groups: "10001",
  trimmed_mean: "999902",
  weighted_median: "999903",
  excluding_volatile_items: "104122",
  rents: "30014",
  housing: "20003",
  food: "20001",
  meals_out: "30007",
  electricity: "40055",
  automotive_fuel: "40081",
  insurance_and_financial: "126670",
} as const;

export const CPI_CITIES = {
  australia: "50", sydney: "1", melbourne: "2", brisbane: "3", adelaide: "4",
  perth: "5", hobart: "6", darwin: "7", canberra: "8",
} as const;

export const CPI_MEASURES = { index: "1", monthly_change: "2", annual_change: "3" } as const;
const ADJ = { original: "10", seasonally_adjusted: "20", trend: "30" } as const;

/** One series per item/city: the requested adjustment if it exists, otherwise whatever ABS publishes. */
function pickAdjustment(raw: AbsRawSeries[], want: string): AbsRawSeries[] {
  const best = new Map<string, AbsRawSeries>();
  for (const s of raw) {
    const k = `${s.dims.INDEX?.code}.${s.dims.REGION?.code}`;
    const cur = best.get(k);
    if (!cur || (s.dims.TSEST?.code === want && cur.dims.TSEST?.code !== want)) best.set(k, s);
  }
  return [...best.values()];
}

const cpiName = (s: AbsRawSeries) => `${s.dims.INDEX?.label} - ${s.dims.REGION?.code === "50" ? "Australia" : s.dims.REGION?.label}`;

/** "2022-05" -> "2022-Q2"; "2022" -> "2022-Q1" */
function toQuarter(p: string): string {
  const [y, m] = p.split("-");
  return `${y}-Q${m ? Math.ceil(Number(m) / 3) : 1}`;
}

export async function getCpi(a: {
  items: (keyof typeof CPI_ITEMS | string)[];
  cities: (keyof typeof CPI_CITIES)[];
  measure: keyof typeof CPI_MEASURES;
  adjustment?: "original" | "seasonally_adjusted";
  start?: string;
  end?: string;
}): Promise<Result> {
  const items = a.items.map((i) => (CPI_ITEMS as Record<string, string>)[i] ?? i);
  const regions = a.cities.map((c) => CPI_CITIES[c]);
  // Leave adjustment as a wildcard: trimmed mean / weighted median only exist seasonally adjusted.
  const q = { dataflow: "CPI", key: `${CPI_MEASURES[a.measure]}.${items.join("+")}..${regions.join("+")}.M`, startPeriod: a.start, endPeriod: a.end };
  const raw = await absFetch(q);
  const want = ADJ[a.adjustment ?? "original"];
  const best = new Map(pickAdjustment(raw, want).map((s) => [`${s.dims.INDEX?.code}.${s.dims.REGION?.code}`, s]));
  const monthly = pickAdjustment([...best.values()], want);
  const firstMonthly = monthly.flatMap((s) => s.points.map((p) => p[0])).sort()[0];
  const { series, notes } = nameSeries(monthly);
  series.forEach((s, i) => (s.name = cpiName(monthly[i]) + " (monthly)"));
  let sourceUrl = absDataUrl(q);

  // The monthly CPI only starts in 2023-2025 depending on the item. If the caller wants earlier history,
  // add the quarterly CPI (published to Sep quarter 2025) as separate series - index bases differ, so they aren't spliced.
  if (a.start && (!firstMonthly || a.start < firstMonthly)) {
    const qq = { dataflow: "ABS,CPI,1.1.0", key: `${CPI_MEASURES[a.measure]}.${items.join("+")}..${regions.join("+")}.Q`, startPeriod: toQuarter(a.start), endPeriod: a.end ? toQuarter(a.end) : undefined };
    const quarterly = pickAdjustment(await absFetch(qq).catch(() => []), want);
    const qs = nameSeries(quarterly).series;
    qs.forEach((s, i) => (s.name = cpiName(quarterly[i]) + " (quarterly)"));
    series.push(...qs);
    sourceUrl += " and " + absDataUrl(qq);
    if (qs.length) notes.push("Includes quarterly CPI series (ends Sep quarter 2025) for history before the monthly CPI starts. For annual_change the two line up and can be read as one timeline; index levels use different bases, so don't join them.");
  } else {
    notes.push("Monthly CPI only. Pass an earlier start (e.g. 2019-01) to also get quarterly CPI history.");
  }
  if (!series.length) notes.push("ABS returned no data for that combination. Not every item is published for every city - try australia, or a broader item.");
  return { source: "ABS Consumer Price Index", sourceUrl, series, notes };
}

// ---------- Labour Force ----------

export const LF_MEASURES = {
  unemployment_rate: "M13",
  participation_rate: "M12",
  employment_to_population: "M16",
  employed: "M3",
  employed_full_time: "M1",
  employed_part_time: "M2",
  unemployed: "M6",
  labour_force: "M9",
} as const;

export const LF_STATES = {
  australia: "AUS", nsw: "1", vic: "2", qld: "3", sa: "4", wa: "5", tas: "6", nt: "7", act: "8",
} as const;

const SEX = { persons: "3", males: "1", females: "2" } as const;

export async function getLabourForce(a: {
  measures: (keyof typeof LF_MEASURES)[];
  states: (keyof typeof LF_STATES)[];
  sex?: keyof typeof SEX;
  adjustment?: keyof typeof ADJ;
  start?: string;
  end?: string;
}): Promise<Result> {
  const key = [
    a.measures.map((m) => LF_MEASURES[m]).join("+"),
    SEX[a.sex ?? "persons"],
    "1599",
    ADJ[a.adjustment ?? "seasonally_adjusted"],
    a.states.map((s) => LF_STATES[s]).join("+"),
    "M",
  ].join(".");
  const q = { dataflow: "LF", key, startPeriod: a.start, endPeriod: a.end };
  const { series, notes } = nameSeries(await absFetch(q));
  if (!series.length) notes.push("ABS returned no data. Trend and seasonally adjusted series aren't published for every state/sex combination - try original.");
  return { source: "ABS Labour Force, Australia (monthly)", sourceUrl: absDataUrl(q), series, notes };
}

// ---------- discovery: search + describe ----------

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export interface Dataflow { id: string; version: string; name: string }

let flowsCache: Dataflow[] | null = null;
export async function listDataflows(): Promise<Dataflow[]> {
  if (flowsCache) return flowsCache;
  const xml = await fetchText(`${BASE}/dataflow/ABS`, XML);
  const out: Dataflow[] = [];
  for (const m of xml.matchAll(/<structure:Dataflow ([^>]*)>([\s\S]*?)<\/structure:Dataflow>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
    const version = /\bversion="([^"]+)"/.exec(m[1])?.[1] ?? "";
    const name = /<common:Name xml:lang="en">([^<]*)<\/common:Name>/.exec(m[2])?.[1];
    if (id && name) out.push({ id, version, name: decode(name) });
  }
  return (flowsCache = out);
}

export async function searchDataflows(query: string, limit = 15): Promise<Dataflow[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const flows = await listDataflows();
  return flows
    .map((f) => {
      const hay = `${f.id} ${f.name}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      // Prefer current national series over census/one-off tables when tied
      if (/census|ACLD|^C\d\d_|_C\d\d_/i.test(f.id + f.name)) score -= 0.3;
      return { f, score };
    })
    .filter((x) => x.score >= Math.max(1, terms.length * 0.6))
    .sort((a, b) => b.score - a.score || a.f.name.length - b.f.name.length)
    .slice(0, limit)
    .map((x) => x.f);
}

export interface DimensionInfo { id: string; position: number; codes: { code: string; label: string }[]; totalCodes: number }

export async function describeDataflow(id: string, maxCodes = 60): Promise<{ id: string; name: string; dimensions: DimensionInfo[]; keyTemplate: string }> {
  const xml = await fetchText(`${BASE}/dataflow/ABS/${encodeURIComponent(id)}/latest?references=all&detail=referencepartial`, XML);
  const codelists = new Map<string, { code: string; label: string }[]>();
  for (const m of xml.matchAll(/<structure:Codelist [^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/structure:Codelist>/g)) {
    const codes = [...m[2].matchAll(/<structure:Code id="([^"]+)"[^>]*>[\s\S]*?<common:Name xml:lang="en">([^<]*)<\/common:Name>/g)].map((c) => ({ code: c[1], label: decode(c[2]) }));
    codelists.set(m[1], codes);
  }
  const dims: DimensionInfo[] = [];
  for (const m of xml.matchAll(/<structure:Dimension id="([^"]+)" position="(\d+)">([\s\S]*?)<\/structure:Dimension>/g)) {
    const cl = /<structure:Enumeration>\s*<Ref id="([^"]+)"/.exec(m[3])?.[1];
    const codes = (cl && codelists.get(cl)) || [];
    dims.push({ id: m[1], position: Number(m[2]), codes: codes.slice(0, maxCodes), totalCodes: codes.length });
  }
  dims.sort((a, b) => a.position - b.position);
  const name = (await listDataflows().catch(() => [])).find((f) => f.id === id)?.name ?? id;
  return { id, name, dimensions: dims, keyTemplate: dims.map((d) => `<${d.id}>`).join(".") };
}
