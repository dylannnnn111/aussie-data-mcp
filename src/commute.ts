// Commute Pulse - the Friday gap in Sydney's return to office, from TfNSW Opal Tap Data.
// Bundled snapshot of the pipeline outputs (github.com/dylannnnn111/commute-pulse).
// Refresh with `npm run sync:commute` after re-running that pipeline.
import { readFile } from "node:fs/promises";
import { parseCsvObjects } from "./csv.js";
import { inRange, makeSeries, Point, Result } from "./series.js";

const DIR = new URL("../data/commute-pulse/", import.meta.url);
const load = async (f: string) => parseCsvObjects(await readFile(new URL(f, DIR), "utf8"));

export const CENTRES = ["Sydney CBD", "North Sydney", "Chatswood", "Macquarie Park", "Strathfield", "Parramatta"] as const;

const NOTES = [
  "Measure: Opal tap-ons 3pm-7pm (people leaving work) per commercial centre. Friday gap = Friday volume / average of Tue-Thu in the same period.",
  "Pre-COVID baseline: 6 Jan - 6 Mar 2020. Public holidays, outages and documented data discrepancy windows are excluded.",
  "Caveat: unclear whether Sydney Metro taps in the CBD are included, so CBD levels vs 2020 may be understated. Ratios within a period are unaffected.",
  "Source: TfNSW Open Data - Opal Tap Data (CC BY 4.0). Analysis: Commute Pulse, dylanlewis.au/projects/commute-pulse",
];

export async function getCommutePulse(a: {
  view: "friday_gap" | "monday_gap" | "evening_volume" | "baseline" | "cbd_hourly" | "suburban_morning";
  centres?: string[];
  start?: string;
  end?: string;
}): Promise<Result> {
  const centres = a.centres?.length ? a.centres : ["Sydney CBD"];
  const match = (r: string) => centres.some((c) => c.toLowerCase() === r.toLowerCase());
  const source = "Commute Pulse (TfNSW Opal Tap Data)";
  const notes = [...NOTES];

  if (a.view === "baseline") {
    const rows = (await load("baseline_pre_covid.csv")).filter((r) => match(r.region));
    return {
      source, notes,
      series: rows.map((r) => makeSeries(`${r.region} - pre-COVID baseline`, "ratio to Tue-Thu average", "Baseline window", [
        ["fri_vs_midweek", Number(r.fri_vs_midweek)], ["mon_vs_midweek", Number(r.mon_vs_midweek)],
      ])),
    };
  }
  if (a.view === "cbd_hourly") {
    const rows = await load("cbd_hourly_profile.csv");
    const series = [];
    for (const win of ["pre_covid", "last_12m"]) for (const dow of ["Tue", "Wed", "Thu", "Fri", "Mon"]) {
      const pts: Point[] = rows.filter((r) => r.window === win && r.dow === dow).map((r) => [r.hour.padStart(2, "0") + ":00", Number(r.tap_ons)]);
      if (pts.length) series.push(makeSeries(`Sydney CBD ${dow} - ${win === "pre_covid" ? "pre-COVID" : "last 12 months"}`, "average tap-ons per hour", "Hourly profile", pts));
    }
    return { source, notes, series };
  }
  if (a.view === "suburban_morning") {
    const rows = await load("suburban_morning.csv");
    const seen = new Set<string>();
    const series = [];
    for (const r of rows) {
      const k = `${r.modes}.${r.window}`;
      if (seen.has(k)) continue;
      seen.add(k);
      series.push(makeSeries(`Suburban 7-9am tap-ons, ${r.modes.replace("_", " ")}, ${r.window === "pre_covid" ? "pre-COVID" : "last 12 months"}`, "Friday / Tue-Thu", "Window", [[r.window, Number(r.fri_vs_midweek)]]));
    }
    notes.push("Suburban = Opal 'Other' region (everywhere outside the named centres) - people leaving home in the morning.");
    return { source, notes, series };
  }

  const rows = (await load("weekday_gap_monthly.csv")).filter((r) => match(r.region));
  const col = a.view === "friday_gap" ? "fri_vs_midweek" : a.view === "monday_gap" ? "mon_vs_midweek" : "Tue";
  const series = centres.map((c) => {
    const pts: Point[] = rows
      .filter((r) => r.region.toLowerCase() === c.toLowerCase() && r[col] !== "" && Number(r.days) >= 8) // skip part months
      .map((r) => [r.period.slice(0, 7), a.view === "evening_volume" ? midweek(r) : Number(r[col])] as Point)
      .filter(([p]) => inRange(p, a.start, a.end));
    const unit = a.view === "evening_volume" ? "average Tue-Thu evening tap-ons per day" : `${a.view === "friday_gap" ? "Friday" : "Monday"} / Tue-Thu average`;
    return makeSeries(c, unit, "Monthly", pts);
  });
  if (series.some((s) => !s.points.length)) notes.push(`Known centres: ${CENTRES.join(", ")}.`);
  notes.push("Months with fewer than 8 usable weekdays are left out.");
  return { source, notes, series };
}

function midweek(r: Record<string, string>): number {
  const v = [r.Tue, r.Wed, r.Thu].map(Number).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
