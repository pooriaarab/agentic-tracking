# agentic-tracking

[![npm version](https://img.shields.io/npm/v/agentic-tracking)](https://www.npmjs.com/package/agentic-tracking)
[![Downloads/month](https://img.shields.io/npm/dm/agentic-tracking)](https://www.npmjs.com/package/agentic-tracking)
[![MIT license](https://img.shields.io/npm/l/agentic-tracking)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tracking) · [Support](https://github.com/pooriaarab/agentic-tracking/issues)

agentic-tracking is an open-source call attribution toolkit for developers who map phone calls to campaigns.
It reads Twilio, Telnyx, or local call records and writes attribution results to configured sinks.
A TypeScript SDK, command-line interface, and Model Context Protocol (MCP) server expose the workflow.

## Install

```sh
npm install agentic-tracking
```

Use Node.js 18 or later. The package includes TypeScript declarations and has three direct runtime dependencies.

## Attribute your first call

Save this as `first-call.mjs`, then run `node first-call.mjs`.
No credentials or environment variables are required for this local example.

```js
import { writeFile, readFile, rm } from 'node:fs/promises';
import { FileSource, FileSink, runAttribution } from 'agentic-tracking';

await writeFile('calls.jsonl', JSON.stringify({
  callSid: 'demo-1', from: '+15551230002', to: '+15551230001',
  durationSec: 60, startedAt: '2026-10-01T12:00:00Z'
}) + '\n');
await rm('attributions.jsonl', { force: true });
const result = await runAttribution({
  query: { file: 'calls.jsonl' },
  lines: [{ number: '+15551230001', campaign: 'demo', source: 'website' }],
  sources: [new FileSource()],
  sinks: [new FileSink({ file: 'attributions.jsonl' })]
});
console.log(result.summary);
console.log(await readFile('attributions.jsonl', 'utf8'));
```

Expect `calls: 1`, `creditedLeads: 1`, and a JSON line with campaign `demo`.
The example replaces its two local demo files on each run.

## How it works

```text
Twilio / Telnyx / JSONL -> line matching -> attribution + summary
                                         -> D1 / Stripe / JSONL
```

Sources pull in parallel. The engine merges calls, matches destination numbers, and pushes results to sinks in parallel.
Each adapter returns its own success or failure.

## Why it exists

CallRail provides a managed call tracking product. Twilio provides programmable telephony APIs.
agentic-tracking provides code-level attribution and sink adapters for developers who operate their own workflow.

## Compare

Scope checked on 2026-10-14 against [CallRail](https://www.callrail.com/call-tracking) and [Twilio Voice](https://www.twilio.com/docs/voice/api).

| Property | agentic-tracking | CallRail | Twilio Voice |
| --- | --- | --- | --- |
| Scope | Call-record attribution and sinks | Call tracking and analytics | Programmable telephony |
| Deployment | Self-hosted Node.js process | Managed service | Managed APIs |
| Configuration | Code, CLI flags, environment | Account dashboard | API requests |
| Pricing model | MIT package; vendor charges apply | Subscription plans | Service usage |
| Coverage here | Twilio, Telnyx, D1, Stripe, local files | CallRail tracking workflow | Twilio calls |

## Coverage

The registries contain three sources and three sinks. All six have implementations; none is a scaffold.

| Integration | Adapter | Status | Setup |
| --- | --- | --- | --- |
| Twilio | `twilio` source and number listing | Implemented; live verification pending | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| Telnyx | `telnyx` source and number listing | Implemented; live verification pending | `TELNYX_API_KEY` |
| Local JSONL | `call-file` source | Implemented; local example verified | File path |
| Cloudflare D1 | `d1-log` sink | Implemented; live verification pending | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN` |
| Stripe Billing | `stripe-billing` sink | Implemented; live verification pending | `STRIPE_SECRET_KEY`, `STRIPE_CUSTOMER_ID` |
| Local JSONL | `file-log` sink | Implemented; local example verified | File path or `TRACKING_LOG_FILE` |

Four network integrations have source-level implementations and mocked tests. This README campaign performs zero live credential checks.
Export credentials before running commands. The package does not load `.env` files automatically.

## Common use cases

1. Agency developers: map Twilio calls to campaign lines and store attribution in Cloudflare D1.
2. Operations teams: inspect Telnyx numbers and assign campaign labels through a line map.
3. Billing developers: send credited leads to a configured Stripe Billing meter.
4. Data engineers: replay JSONL call records and inspect local attribution output.

## Features

- **Line attribution:** Map destination numbers to campaign and source labels.
- **Summaries:** Report calls, credited leads, and minutes by campaign and source.
- **Preview mode:** Inspect selected adapters without pulling calls or writing results.
- **Adapter results:** Inspect individual source and sink errors.
- **Session usage:** Read call units recorded by the current process.

## Runtime surfaces

The SDK targets Node.js 18+. It exports adapter classes, attribution helpers, and the shared `agentic-core` API.

CLI commands: `attribute`, `lines`, `sources`, `costs`, `doctor`, `mcp`, `help`, and `version`.
Use `npx agentic-tracking help` for flags. `--help`, `-h`, `--version`, and `-V` are aliases.

MCP tools: `attribute_calls`, `list_lines`, `list_sources`, and `get_cost_report`.
Start stdio MCP with `npx agentic-tracking-mcp` or `npx agentic-tracking mcp`.

The repository also contains a Worker handler with `GET /health` and `POST /attribute`.
It is not a managed endpoint. Its file adapters require a Node filesystem, and network adapters read `process.env`.
Check runtime compatibility and credential wiring before deploying it.

## Delivery and behavior limits

The SDK defaults to live execution. CLI attribution, MCP attribution, and the Worker handler default to preview mode.
Select adapters explicitly; default SDK sources and sinks include all registered adapters.
CLI live failures exit 1. Invalid CLI usage exits 2.

Number matching compares the last ten digits for numbers with at least seven digits.
Unknown lines produce `unassigned` campaigns and `unknown` sources.
A matched call credits a lead when duration is positive or absent. Zero duration does not credit a lead.
This rule does not establish lead quality, consent, or advertising attribution.

Network requests default to a ten-second timeout. The package has no automatic retry loop or source deduplication.
Twilio reads one call page, capped at 1,000 records. Telnyx reads one detail-record page, capped at 50.
Twilio date filtering uses the start date. Telnyx filters the API query by `created_at`, then filters phone numbers locally.

D1 creates `call_attributions` and upserts by call SID. Generated local IDs can collide across runs.
The file sink appends records without deduplication.
Stripe submits credited leads sequentially with the call SID as the meter-event identifier.
Stripe can receive partial writes before a later event fails; the reported sink result does not enumerate those writes.
Usage reports count calls, not money, and disappear when the process exits.

## Integration setup

Twilio and Telnyx constructors accept credentials, custom base URLs, `fetchFn`, and `timeoutMs`.
`listLines(lineMap)` maps owned numbers to campaign labels. Unmapped numbers retain `unassigned` campaigns.

D1 requires an API token with access to the selected database.
Its optional `table` accepts a SQL identifier containing letters, digits, and underscores.

Create a Stripe meter before pushing leads. Its event name must match `STRIPE_EVENT_NAME`, which defaults to `credited_lead`.
All events use the configured customer ID. Invalid or out-of-window call timestamps are omitted.

Local call files use one JSON object per line. Only `from` and `to` are required.
Line-map files use a JSON array of objects with `number`, `campaign`, and `source`.

## Status

Version 0.2.0 is an early release; APIs can change before 1.0.
Report problems through [GitHub issues](https://github.com/pooriaarab/agentic-tracking/issues).
Public case studies are not yet published.

## FAQ

### Which integrations are verified?

agentic-tracking has three implemented sources and three implemented sinks. Local execution and mocked tests are verified; live vendor credentials are not checked here.

### Does agentic-tracking provide a managed call tracking service?

agentic-tracking runs in your process. You supply vendor accounts, credentials, campaign mappings, and deployment infrastructure.

### How is agentic-tracking different from CallRail?

agentic-tracking provides attribution code and adapters. CallRail provides a managed call tracking product with its own account workflow.

### How is agentic-tracking different from Twilio Voice?

agentic-tracking reads existing call records and attributes them. Twilio Voice supplies telephony APIs that can create and manage calls.

### Can I try it without vendor credentials?

agentic-tracking supports JSONL input and output. The quickstart demonstrates one attributed call without network access.

### Does agentic-tracking load my .env file?

agentic-tracking reads the process environment. Load your environment file through your runtime or export its values before execution.

### How does agentic-tracking credit leads?

agentic-tracking credits matched calls with positive or omitted duration. A matched call with zero duration receives no credit.

### Does agentic-tracking retry failed requests?

agentic-tracking reports adapter failures without automatic retries. Inspect each result before deciding whether to replay a run.

### Can agents preview attribution safely?

agentic-tracking defaults MCP attribution to dry run. Preview returns adapter names and line count without source pulls or sink writes.

## License

MIT.
