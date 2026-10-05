#!/usr/bin/env node
// Aussie Data MCP - lets an LLM query ABS, RBA and Commute Pulse (TfNSW Opal) data directly.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CPI_CITIES, CPI_ITEMS, CPI_MEASURES, describeDataflow, getCpi, getLabourForce, LF_MEASURES, LF_STATES, absFetch, absDataUrl, nameSeries, searchDataflows } from "./abs.js";
import { CENTRES, getCommutePulse } from "./commute.js";
import { CURRENCIES, getCashRate, getExchangeRates, getLendingRates, LENDING_RATES, rbaSeries } from "./rba.js";

const server = new McpServer({ name: "aussie-data", version: "0.1.0" });

const keys = <T extends Record<string, unknown>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const month = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM or YYYY-MM-DD");
const start = month.optional().describe("Earliest period, YYYY-MM (e.g. 2022-01). Omit for the full history.");
const end = month.optional().describe("Latest period, YYYY-MM. Omit for up to the latest release.");

// Every tool returns compact JSON. Errors come back as a readable message (isError) instead of throwing,
// so the model can fix its arguments and try again.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tool(fn: (a: any) => Promise<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (a: any) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(a)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  };
}

server.registerTool("get_cpi", {
  title: "Consumer prices (CPI)",
  description:
    "Australian inflation from the ABS monthly Consumer Price Index, by item and capital city. " +
    "Use measure 'annual_change' for 'what is inflation' (year-on-year %), 'monthly_change' for month-on-month %, 'index' for price levels. " +
    "The RBA's preferred underlying measure is trimmed_mean. For rent inflation use item 'rents'. " +
    "Other items can be passed as an ABS CPI index code (find codes with abs_describe_dataflow on 'CPI').",
  inputSchema: {
    items: z.array(z.string()).min(1).default(["all_groups"]).describe(`One or more of: ${Object.keys(CPI_ITEMS).join(", ")} - or a raw ABS CPI index code.`),
    cities: z.array(z.enum(keys(CPI_CITIES))).min(1).default(["australia"]).describe("Capital cities, or 'australia' for the weighted average of the eight capitals."),
    measure: z.enum(keys(CPI_MEASURES)).default("annual_change"),
    adjustment: z.enum(["original", "seasonally_adjusted"]).default("original").describe("Falls back to whatever ABS publishes (trimmed mean is seasonally adjusted only)."),
    start, end,
  },
}, tool(getCpi));

server.registerTool("get_labour_force", {
  title: "Jobs and unemployment",
  description:
    "ABS Labour Force survey, monthly: unemployment rate, participation, employment and more, for Australia or any state/territory. " +
    "Rates are in %, counts are in thousands of people. Seasonally adjusted by default, which is what news reports quote.",
  inputSchema: {
    measures: z.array(z.enum(keys(LF_MEASURES))).min(1).default(["unemployment_rate"]),
    states: z.array(z.enum(keys(LF_STATES))).min(1).default(["australia"]),
    sex: z.enum(["persons", "males", "females"]).default("persons"),
    adjustment: z.enum(["seasonally_adjusted", "trend", "original"]).default("seasonally_adjusted"),
    start, end,
  },
}, tool(getLabourForce));

server.registerTool("get_cash_rate", {
  title: "RBA cash rate",
  description: "The Reserve Bank of Australia cash rate target, monthly average (% per year). Use for 'what's the cash rate', rate hikes/cuts over time, or to line up rates against CPI, rents or jobs.",
  inputSchema: { start, end },
}, tool(getCashRate));

server.registerTool("get_lending_rates", {
  title: "Mortgage and loan rates",
  description: "RBA indicator lending rates (advertised, % per year), monthly: home loans for owner-occupiers and investors (variable standard, variable discounted, 3-year fixed), small business, credit cards and personal loans.",
  inputSchema: {
    rates: z.array(z.enum(keys(LENDING_RATES))).min(1).default(["owner_occupier_variable_discounted"]),
    start, end,
  },
}, tool(getLendingRates));

server.registerTool("get_exchange_rates", {
  title: "AUD exchange rates",
  description: "Australian dollar exchange rates from the RBA (units of foreign currency per A$1), plus the trade-weighted index (TWI). Daily data from 2023; monthly (last value of each month) by default.",
  inputSchema: {
    currencies: z.array(z.enum(CURRENCIES)).min(1).default(["USD"]),
    monthly: z.boolean().default(true).describe("false returns every trading day."),
    start, end,
  },
}, tool(getExchangeRates));

server.registerTool("rba_series", {
  title: "Any RBA statistical table",
  description:
    "Fallback for RBA data the focused tools don't cover (e.g. f6 actual lending rates, f2 bond yields, g1 inflation expectations, d1 credit growth). " +
    "Call with just `table` to list its series, then again with `series` ids (or a `search` phrase) to get the data.",
  inputSchema: {
    table: z.string().describe("RBA table id as on rba.gov.au/statistics/tables, e.g. f6, f2, g1, d1."),
    series: z.array(z.string()).optional().describe("Series IDs from the table's list, e.g. FILRHLBVS."),
    search: z.string().optional().describe("Words that must all appear in the series title, e.g. 'owner-occupier variable'."),
    monthly: z.boolean().default(false).describe("Collapse daily/weekly series to month-end."),
    start, end,
  },
}, tool(rbaSeries));

server.registerTool("get_commute_pulse", {
  title: "Sydney return-to-office (Opal)",
  description:
    "How Sydney is commuting since COVID, from TfNSW Opal tap data (Commute Pulse). " +
    "'friday_gap' = Friday evening tap-ons as a share of Tue-Thu, monthly since 2020 - the core return-to-office measure (1.0 = no gap). " +
    "Also: 'monday_gap', 'evening_volume' (Tue-Thu evening tap-ons per day), 'baseline' (pre-COVID ratios), 'cbd_hourly' (CBD tap-ons by hour, pre-COVID vs last 12 months), 'suburban_morning' (Friday vs midweek 7-9am outside the centres).",
  inputSchema: {
    view: z.enum(["friday_gap", "monday_gap", "evening_volume", "baseline", "cbd_hourly", "suburban_morning"]).default("friday_gap"),
    centres: z.array(z.enum(CENTRES)).optional().describe("Commercial centres. Default Sydney CBD."),
    start, end,
  },
}, tool(getCommutePulse));

server.registerTool("abs_search_dataflows", {
  title: "Find an ABS dataset",
  description: "Search the ABS Data API catalogue (1,000+ datasets) by keyword. Use when CPI and Labour Force don't cover the question - e.g. wages, building approvals, population, retail trade, GDP. Returns dataflow ids for abs_describe_dataflow.",
  inputSchema: { query: z.string().min(2).describe("Keywords, e.g. 'wage price index' or 'building approvals'.") },
}, tool(async ({ query }: { query: string }) => ({ results: await searchDataflows(query) })));

server.registerTool("abs_describe_dataflow", {
  title: "Describe an ABS dataset",
  description: "List an ABS dataflow's dimensions (in key order) and their codes, so you can build an SDMX key for abs_get_data. Use `code_search` to find codes in big codelists (e.g. 'rent' in CPI's INDEX).",
  inputSchema: {
    dataflow: z.string().describe("Dataflow id, e.g. WPI, CPI, LF, BA_GCCSA."),
    code_search: z.string().optional().describe("Only return codes whose label contains this text."),
  },
}, tool(async ({ dataflow, code_search }: { dataflow: string; code_search?: string }) => {
  const d = await describeDataflow(dataflow, code_search ? 10_000 : 60);
  if (code_search) {
    const s = code_search.toLowerCase();
    for (const dim of d.dimensions) dim.codes = dim.codes.filter((c) => c.label.toLowerCase().includes(s) || c.code.toLowerCase() === s).slice(0, 60);
  }
  return { ...d, howToBuildKey: "Join one code per dimension with '.', in this order. Use '+' for several codes (1+2) and leave a dimension empty for all codes (1..50.M)." };
}));

server.registerTool("abs_get_data", {
  title: "Get ABS data",
  description: "Fetch any ABS dataflow with an SDMX key from abs_describe_dataflow. Keep keys narrow - an empty key on a big dataflow returns thousands of series. Use last_n to just get the latest values.",
  inputSchema: {
    dataflow: z.string(),
    key: z.string().describe("SDMX key, e.g. '3.10001.10.50.M'. Use 'all' only with last_n on small dataflows."),
    last_n: z.number().int().min(1).max(500).optional().describe("Only the last N observations per series."),
    start, end,
  },
}, tool(async (a: { dataflow: string; key: string; last_n?: number; start?: string; end?: string }) => {
  const q = { dataflow: a.dataflow, key: a.key, startPeriod: a.start, endPeriod: a.end, lastN: a.last_n };
  const raw = await absFetch(q);
  if (raw.length > 40) throw new Error(`That key matches ${raw.length} series - too many to return. Narrow it (pin more dimensions).`);
  const { series, notes } = nameSeries(raw);
  if (!series.length) notes.push("No data for that key. Check codes with abs_describe_dataflow.");
  return { source: `ABS ${a.dataflow}`, sourceUrl: absDataUrl(q), series, notes };
}));

await server.connect(new StdioServerTransport());
