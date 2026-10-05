// Eval: 20 plain-English questions run through Claude with this server's tools.
// Checks (1) Claude called the right tool and (2) the number in its answer matches the live data.
// Ground truth comes from calling the same tools directly, so it stays correct as data updates.
//
// Run:  ANTHROPIC_API_KEY must be set in your shell (never commit it), then
//       npm run eval                      (all questions)
//       npm run eval -- 3 7               (only questions 3 and 7)
// Model: EVAL_MODEL env var, otherwise the newest Sonnet your key can use.
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";

const MAX_TURNS = 8;

interface Series { name: string; latest?: { period: string; value: number }; start?: { value: number }; change?: number }
type Pick = (series: Series[]) => number | undefined;

interface Case {
  q: string;
  tools: string[]; // every one of these must be called
  truth?: { tool: string; args: Record<string, unknown>; pick: Pick; tol?: number };
}

const latest: Pick = (s) => s[0]?.latest?.value;
const named = (part: string): Pick => (s) => s.find((x) => x.name.toLowerCase().includes(part.toLowerCase()))?.latest?.value;
const maxLatest: Pick = (s) => Math.max(...s.map((x) => x.latest?.value ?? -Infinity));
const change: Pick = (s) => s[0]?.change;

const CASES: Case[] = [
  { q: "What's Australia's inflation rate right now?", tools: ["get_cpi"],
    truth: { tool: "get_cpi", args: { items: ["all_groups"], cities: ["australia"], measure: "annual_change" }, pick: latest } },
  { q: "What's the RBA's preferred measure of underlying inflation at the moment?", tools: ["get_cpi"],
    truth: { tool: "get_cpi", args: { items: ["trimmed_mean"], cities: ["australia"], measure: "annual_change" }, pick: latest } },
  { q: "How fast are rents rising in Sydney?", tools: ["get_cpi"],
    truth: { tool: "get_cpi", args: { items: ["rents"], cities: ["sydney"], measure: "annual_change" }, pick: latest } },
  { q: "Which capital city has the fastest rent growth right now, and what is it?", tools: ["get_cpi"],
    truth: { tool: "get_cpi", args: { items: ["rents"], cities: ["sydney", "melbourne", "brisbane", "adelaide", "perth", "hobart", "darwin", "canberra"], measure: "annual_change" }, pick: maxLatest } },
  { q: "How much have electricity prices gone up over the past year?", tools: ["get_cpi"],
    truth: { tool: "get_cpi", args: { items: ["electricity"], cities: ["australia"], measure: "annual_change" }, pick: latest } },
  { q: "What's the cash rate?", tools: ["get_cash_rate"],
    truth: { tool: "get_cash_rate", args: {}, pick: latest } },
  { q: "By how many percentage points has the cash rate risen since January 2022?", tools: ["get_cash_rate"],
    truth: { tool: "get_cash_rate", args: { start: "2022-01" }, pick: change } },
  { q: "What's the unemployment rate in NSW?", tools: ["get_labour_force"],
    truth: { tool: "get_labour_force", args: { measures: ["unemployment_rate"], states: ["nsw"] }, pick: latest, tol: 0.1 } },
  { q: "What's Australia's unemployment rate?", tools: ["get_labour_force"],
    truth: { tool: "get_labour_force", args: { measures: ["unemployment_rate"], states: ["australia"] }, pick: latest, tol: 0.1 } },
  { q: "What's the labour force participation rate in Victoria?", tools: ["get_labour_force"],
    truth: { tool: "get_labour_force", args: { measures: ["participation_rate"], states: ["vic"] }, pick: latest, tol: 0.1 } },
  { q: "What's the standard variable home loan rate banks advertise to owner-occupiers?", tools: ["get_lending_rates"],
    truth: { tool: "get_lending_rates", args: { rates: ["owner_occupier_variable_standard"] }, pick: latest } },
  { q: "What's the going 3-year fixed rate for property investors?", tools: ["get_lending_rates"],
    truth: { tool: "get_lending_rates", args: { rates: ["investor_3yr_fixed"] }, pick: latest } },
  { q: "What's the Aussie dollar worth in US dollars?", tools: ["get_exchange_rates"],
    truth: { tool: "get_exchange_rates", args: { currencies: ["USD"], monthly: false }, pick: latest, tol: 0.01 } },
  { q: "Where's the Australian dollar's trade-weighted index sitting?", tools: ["get_exchange_rates"],
    truth: { tool: "get_exchange_rates", args: { currencies: ["TWI"], monthly: false }, pick: latest, tol: 0.5 } },
  { q: "Is Sydney back in the office on Fridays? What's the latest Friday vs midweek ratio for the CBD?", tools: ["get_commute_pulse"],
    truth: { tool: "get_commute_pulse", args: { view: "friday_gap", centres: ["Sydney CBD"] }, pick: latest } },
  { q: "Which has the bigger Friday drop-off, North Sydney or Chatswood? Give me North Sydney's ratio.", tools: ["get_commute_pulse"],
    truth: { tool: "get_commute_pulse", args: { view: "friday_gap", centres: ["North Sydney", "Chatswood"] }, pick: named("North Sydney") } },
  { q: "Before COVID, how did Friday evening CBD travel compare to midweek?", tools: ["get_commute_pulse"],
    truth: { tool: "get_commute_pulse", args: { view: "baseline", centres: ["Sydney CBD"] }, pick: (s) => (s[0] as unknown as { points: [string, number][] })?.points.find((p) => p[0] === "fri_vs_midweek")?.[1] } },
  { q: "How fast are wages growing in Australia? Use the ABS Wage Price Index.", tools: ["abs_get_data"] },
  { q: "How has Sydney rent moved against the cash rate since 2022?", tools: ["get_cpi", "get_cash_rate"],
    truth: { tool: "get_cash_rate", args: {}, pick: latest } },
  { q: "What interest rate are owner-occupiers actually paying on new variable home loans, not the advertised rate?", tools: ["rba_series"] },
];

// ---------- helpers ----------

function numbersIn(text: string): number[] {
  return [...text.replace(/,(?=\d{3})/g, "").matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/** Pass if any number in the answer is within tolerance of the truth, allowing for % vs ratio and cents vs dollars. */
function matches(answer: string, truth: number, tol: number): boolean {
  const candidates = [truth, truth * 100, truth / 100];
  return numbersIn(answer).some((n) => candidates.some((c) => Math.abs(n - c) <= Math.max(tol, Math.abs(c) * 0.01)));
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
}

// ---------- run ----------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in your shell first (export ANTHROPIC_API_KEY=...). Don't put it in a file in this repo.");
  process.exit(1);
}

const only = process.argv.slice(2).map(Number).filter((n) => n > 0);
const client = new Client({ name: "aussie-data-eval", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const { tools } = await client.listTools();
const anthropicTools = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
const anthropic = new Anthropic();

// Ask the API which models this key can use rather than hardcoding a name that goes stale.
async function pickModel(): Promise<string> {
  if (process.env.EVAL_MODEL) return process.env.EVAL_MODEL;
  const ids: string[] = [];
  for await (const m of anthropic.models.list({ limit: 100 })) ids.push(m.id); // newest first
  const sonnet = ids.find((id) => id.includes("sonnet"));
  if (!sonnet) throw new Error(`No Sonnet model available to this key. Available: ${ids.join(", ")}. Set EVAL_MODEL to one of them.`);
  return sonnet;
}
const MODEL = await pickModel();
console.log(`Model: ${MODEL}\n`);
const today = new Date().toISOString().slice(0, 10);

const results = [];
let tokensIn = 0, tokensOut = 0;

for (const [i, c] of CASES.entries()) {
  if (only.length && !only.includes(i + 1)) continue;
  const t0 = Date.now();
  const calls: { name: string; input: unknown; error: boolean }[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.q }];
  let answer = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 1500, tools: anthropicTools, messages,
      system: `Today's date is ${today}. Answer with specific figures and the period they refer to.`,
    });
    tokensIn += res.usage.input_tokens; tokensOut += res.usage.output_tokens;
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    answer = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (!uses.length) break;
    const out: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const r = await callTool(client, u.name, u.input as Record<string, unknown>);
      calls.push({ name: u.name, input: u.input, error: r.isError });
      out.push({ type: "tool_result", tool_use_id: u.id, content: r.text, is_error: r.isError });
    }
    messages.push({ role: "user", content: out });
  }

  const called = new Set(calls.map((x) => x.name));
  const toolOk = c.tools.every((t) => called.has(t));
  let truth: number | undefined;
  let numberOk: boolean | null = null;
  if (c.truth) {
    const r = await callTool(client, c.truth.tool, c.truth.args);
    truth = c.truth.pick(JSON.parse(r.text).series ?? []);
    numberOk = truth != null && Number.isFinite(truth) ? matches(answer, truth, c.truth.tol ?? 0.05) : null;
  }
  const pass = toolOk && numberOk !== false;
  results.push({ n: i + 1, q: c.q, pass, toolOk, numberOk, truth, expectedTools: c.tools, calls, errors: calls.filter((x) => x.error).length, ms: Date.now() - t0, answer });
  console.log(`${pass ? "PASS" : "FAIL"} ${String(i + 1).padStart(2)}  tool:${toolOk ? "ok" : "MISS"}  number:${numberOk === null ? "-" : numberOk ? "ok" : "WRONG"}${truth != null ? ` (truth ${truth})` : ""}  calls:${calls.map((x) => x.name + (x.error ? "!" : "")).join(",") || "none"}  ${c.q}`);
}

await client.close();
const passed = results.filter((r) => r.pass).length;
const summary = {
  model: MODEL, date: today, total: results.length, passed,
  toolAccuracy: results.filter((r) => r.toolOk).length / results.length,
  numberAccuracy: (() => { const n = results.filter((r) => r.numberOk !== null); return n.filter((r) => r.numberOk).length / (n.length || 1); })(),
  avgToolCalls: results.reduce((a, r) => a + r.calls.length, 0) / results.length,
  toolErrors: results.reduce((a, r) => a + r.errors, 0),
  tokensIn, tokensOut,
};
await mkdir("eval-out", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
await writeFile(`eval-out/run-${stamp}.json`, JSON.stringify({ summary, results }, null, 2));
console.log(`\n${passed}/${results.length} passed  |  tool ${(summary.toolAccuracy * 100).toFixed(0)}%  number ${(summary.numberAccuracy * 100).toFixed(0)}%  |  ${summary.avgToolCalls.toFixed(1)} calls/question, ${summary.toolErrors} tool errors  |  ${tokensIn} in / ${tokensOut} out tokens`);
console.log(`Full transcript: eval-out/run-${stamp}.json`);
