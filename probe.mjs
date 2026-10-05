// Probe the real ABS and RBA endpoints and save samples, so the server is built
// against what the APIs actually return. No dependencies - needs Node 18+.
// Run from the aussie-data-mcp folder:  node probe.mjs
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "probe-out";
await mkdir(OUT, { recursive: true });

const ABS = "https://data.api.abs.gov.au/rest";
const CSV = { Accept: "application/vnd.sdmx.data+csv;labels=both" };
const XML = { Accept: "application/vnd.sdmx.structure+xml;version=2.1" };

const jobs = [
  // ABS: which dataflows exist (ids + versions) - used to find CPI, LF, rents etc.
  ["abs-dataflows.xml", `${ABS}/dataflow/ABS`, XML],
  // ABS: structure of CPI and Labour Force (dimension order + codelists)
  ["abs-cpi-structure.xml", `${ABS}/dataflow/ABS/CPI/latest?references=all&detail=referencepartial`, XML],
  ["abs-lf-structure.xml", `${ABS}/dataflow/ABS/LF/latest?references=all&detail=referencepartial`, XML],
  // ABS: one recent observation of every CPI / LF series, with labels
  ["abs-cpi-sample.csv", `${ABS}/data/ABS,CPI/all?lastNObservations=1`, CSV],
  ["abs-lf-sample.csv", `${ABS}/data/ABS,LF/all?lastNObservations=1`, CSV],
  // RBA statistical tables (CSV)
  ["rba-f1.1.csv", "https://www.rba.gov.au/statistics/tables/csv/f1.1-data.csv", {}],
  ["rba-f5.csv", "https://www.rba.gov.au/statistics/tables/csv/f5-data.csv", {}],
  ["rba-f11.1.csv", "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv", {}],
];

const summary = [];
for (const [file, url, headers] of jobs) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": "aussie-data-mcp probe", ...headers } });
    const buf = Buffer.from(await res.arrayBuffer());
    // Keep files small enough to read: first 400 KB is plenty to see the shape
    await writeFile(`${OUT}/${file}`, buf.subarray(0, 400_000));
    summary.push({ file, url, status: res.status, type: res.headers.get("content-type"), bytes: buf.length, ms: Date.now() - t0 });
  } catch (e) {
    summary.push({ file, url, error: String(e), ms: Date.now() - t0 });
  }
  console.log(summary.at(-1));
}
await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(`\nDone. Samples saved in ${OUT}/`);
