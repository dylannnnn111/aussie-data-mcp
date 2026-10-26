// Pure parts of the daily health check: what one check's result looks like, and how today's run is
// compared with yesterday's to spot a source that broke, went stale or changed shape.

export interface CheckResult {
  id: string;
  ok: boolean;
  ms: number;
  error?: string;
  series?: number; // how many series came back
  latestPeriod?: string; // latest period of the first series, e.g. 2026-09
  latestValue?: number;
  notes?: number;
}

export interface Run {
  at: string; // ISO time of the run
  version: string; // package version checked
  checks: CheckResult[];
}

/** Days old a check's latest period may be before it counts as stale. */
export const MAX_AGE_DAYS: Record<string, number> = {
  cpi: 75, // monthly CPI, released about 4 weeks after the month
  labour_force: 60,
  cash_rate: 45, // monthly average from F1.1
  lending_rates: 75,
  exchange_rates: 45,
};

/** First day of a period string (YYYY, YYYY-MM, YYYY-MM-DD or YYYY-Qn). */
export function periodStart(p: string): Date | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, 1));
  m = /^(\d{4})-Q([1-4])$/.exec(p);
  if (m) return new Date(Date.UTC(+m[1], (+m[2] - 1) * 3, 1));
  m = /^(\d{4})$/.exec(p);
  if (m) return new Date(Date.UTC(+m[1], 0, 1));
  return null;
}

/** Everything about today's run worth a human's attention, as plain sentences. Empty = all fine. */
export function findDrift(today: Run, previous: Run | undefined, now = new Date(today.at)): string[] {
  const out: string[] = [];
  const prev = new Map((previous?.checks ?? []).map((c) => [c.id, c]));
  for (const c of today.checks) {
    const p = prev.get(c.id);
    if (!c.ok) { out.push(`${c.id}: failed - ${c.error ?? "no error message"}`); continue; }
    if (c.series === 0) out.push(`${c.id}: returned no series`);
    if (p?.ok && p.series !== undefined && c.series !== undefined && p.series !== c.series)
      out.push(`${c.id}: series count changed from ${p.series} to ${c.series}`);
    if (p?.ok && p.latestPeriod && c.latestPeriod && c.latestPeriod < p.latestPeriod)
      out.push(`${c.id}: latest period went backwards, ${p.latestPeriod} to ${c.latestPeriod}`);
    if (p?.ok && (p.notes ?? 0) < (c.notes ?? 0))
      out.push(`${c.id}: new note(s) in the result (${p.notes ?? 0} to ${c.notes})`);
    const max = MAX_AGE_DAYS[c.id];
    const start = c.latestPeriod ? periodStart(c.latestPeriod) : null;
    if (max && start) {
      const age = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
      if (age > max) out.push(`${c.id}: latest period ${c.latestPeriod} is ${age} days old (limit ${max})`);
    }
  }
  for (const id of prev.keys()) if (!today.checks.some((c) => c.id === id)) out.push(`${id}: check missing from today's run`);
  return out;
}
