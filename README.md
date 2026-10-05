# Aussie Data MCP

An MCP server that lets Claude (or any MCP client) query Australian economic and transport data directly: ABS, RBA, and Sydney Opal tap data from [Commute Pulse](https://dylanlewis.au/projects/commute-pulse).

Ask things like "how has Sydney rent moved against the cash rate since 2022?" and the model pulls the real series instead of guessing.

## Tools

| Tool | What it answers | Source |
|---|---|---|
| `get_cpi` | Inflation by item and capital city (headline, trimmed mean, rents, electricity...) | ABS monthly CPI |
| `get_labour_force` | Unemployment, participation, employment by state | ABS Labour Force |
| `get_cash_rate` | RBA cash rate target, monthly | RBA F1.1 |
| `get_lending_rates` | Home loan, business and personal lending rates | RBA F5 |
| `get_exchange_rates` | AUD against 18 currencies, plus the TWI | RBA F11.1 |
| `rba_series` | Any other RBA table (list its series, then fetch) | RBA statistical tables |
| `get_commute_pulse` | Sydney's Friday gap and return-to-office patterns since 2020 | TfNSW Opal Tap Data |
| `abs_search_dataflows` | Find any ABS dataset by keyword | ABS Data API |
| `abs_describe_dataflow` | Dimensions and codes for an ABS dataset | ABS Data API |
| `abs_get_data` | Fetch any ABS dataset by SDMX key | ABS Data API |

Every tool returns compact JSON: named series with units, the latest value, the start value and the change over the window already worked out, plus notes on caveats. No API keys needed.

## Use it with Claude Desktop

Add this to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "aussie-data": {
      "command": "npx",
      "args": ["-y", "aussie-data-mcp"]
    }
  }
}
```

Or from a local clone, point it at the build: `"command": "node", "args": ["/path/to/aussie-data-mcp/dist/index.js"]`.

## Develop

```bash
npm install
npm run smoke     # hits every live source and prints a summary
npm run inspect   # opens the MCP Inspector against the server
```

Responses are cached for 6 hours (memory + temp dir). Override with `AUSSIE_DATA_CACHE_TTL_HOURS` and `AUSSIE_DATA_CACHE_DIR`.

Commute Pulse data is a bundled snapshot of that pipeline's outputs. After re-running it, refresh with `npm run sync:commute`.

## Data and licences

- ABS data: [ABS Data API](https://www.abs.gov.au/about/data-services/application-programming-interfaces-apis/data-api-user-guide), CC BY 4.0
- RBA data: [RBA statistical tables](https://www.rba.gov.au/statistics/tables/), see the RBA's copyright terms
- Opal data: [TfNSW Open Data - Opal Tap Data](https://opendata.transport.nsw.gov.au/), CC BY 4.0

Code: MIT.
