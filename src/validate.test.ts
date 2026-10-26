import assert from "node:assert/strict";
import { test } from "node:test";
import { absDataUrl } from "./abs.js";
import { tableUrl } from "./rba.js";
import { checkId } from "./validate.js";

test("real ids pass", () => {
  for (const v of ["f1", "f1.1", "F11.1", "g1", "d1"]) checkId("rbaTable", v);
  for (const v of ["CPI", "BA_GCCSA", "ABS,CPI,1.1.0"]) checkId("absDataflow", v);
  for (const v of ["3.10001.10.50.M", "1+2..50.M", "all", ""]) checkId("absKey", v);
  for (const v of ["30014", "all_groups"]) checkId("absCode", v);
});

test("ids that would change the URL are refused before any request", () => {
  assert.throws(() => tableUrl("../../x"));
  assert.throws(() => tableUrl("f1?x=1"));
  assert.throws(() => absDataUrl({ dataflow: "CPI/../x", key: "all" }));
  assert.throws(() => absDataUrl({ dataflow: "CPI", key: "1.2/../../evil" }));
  assert.throws(() => absDataUrl({ dataflow: "CPI", key: "a?b=c" }));
  assert.throws(() => checkId("absCode", "1/2"));
});

test("URLs are unchanged for valid ids", () => {
  assert.equal(tableUrl("F11.1"), "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv");
  assert.equal(absDataUrl({ dataflow: "CPI", key: "3.10001.10.50.M", startPeriod: "2024-01" }), "https://data.api.abs.gov.au/rest/data/ABS,CPI/3.10001.10.50.M?startPeriod=2024-01");
});
