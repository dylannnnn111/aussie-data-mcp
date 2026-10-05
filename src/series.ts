// Shared result shape: every tool returns series the model can quote directly,
// with the latest value and the change over the window already worked out.

export type Point = [period: string, value: number];

export interface Series {
  name: string;
  unit: string;
  frequency: string;
  latest?: { period: string; value: number };
  start?: { period: string; value: number };
  change?: number; // latest - start, in the series' own unit
  points: Point[];
}

export interface Result {
  source: string;
  sourceUrl?: string;
  series: Series[];
  notes?: string[];
}

const round = (v: number, dp = 4) => Math.round(v * 10 ** dp) / 10 ** dp;

export function makeSeries(name: string, unit: string, frequency: string, points: Point[]): Series {
  const pts = points
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, v]) => [p, round(v)] as Point);
  const s: Series = { name, unit, frequency, points: pts };
  if (pts.length) {
    const [fp, fv] = pts[0];
    const [lp, lv] = pts[pts.length - 1];
    s.start = { period: fp, value: fv };
    s.latest = { period: lp, value: lv };
    s.change = round(lv - fv);
  }
  return s;
}

/** Keep period strings within [start, end]. Works for YYYY, YYYY-MM, YYYY-MM-DD. */
export function inRange(period: string, start?: string, end?: string): boolean {
  if (start && period < start) return false;
  if (end && period.slice(0, end.length) > end) return false;
  return true;
}

/** Collapse daily points to one per month (last value in the month). */
export function monthlyLast(points: Point[]): Point[] {
  const byMonth = new Map<string, Point>();
  for (const p of points) byMonth.set(p[0].slice(0, 7), [p[0].slice(0, 7), p[1]]);
  return [...byMonth.values()];
}

/** Guard against flooding the context: keep at most `max` points, evenly spaced, always keeping the last. */
export function thin(points: Point[], max = 400): { points: Point[]; thinned: boolean } {
  if (points.length <= max) return { points, thinned: false };
  const step = points.length / max;
  const out: Point[] = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return { points: out, thinned: true };
}
