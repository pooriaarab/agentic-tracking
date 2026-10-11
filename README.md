# Agentic tracking

Attribute calls to lines and credit leads.

Match each inbound call to the line that rang.
Log every attributed call to a SQL store.
Send each credited lead to usage billing.

## Start

Use Node.js 18 or later. Install and check the package:

```sh
npm install
npm run build
npm run typecheck
npm test
node dist/cli.js --help
node dist/cli.js sources
node dist/cli.js doctor
node dist/cli.js attribute --source call-file --file examples/calls.jsonl --lines examples/lines.json
TRACKING_LOG_FILE=/tmp/agentic-tracking.jsonl node dist/cli.js attribute --source call-file --sink file-log --file examples/calls.jsonl --lines examples/lines.json --live
node dist/cli.js costs
```

Attribute defaults to a dry run. It calls no source and records no cost.
Add `--live` to pull calls and push results. Select one source with
`--source`, one sink with `--sink`, or use `all`.
Each source and sink returns its own success or error.
Failed sources or sinks cause CLI exit 1.
Bad CLI usage exits 2. Cost entries count calls, not currency.
Reports stay in the current process and reset when it exits.

The live example writes to TRACKING_LOG_FILE.
The file sink appends one JSON line per attribution.

## Sources and sinks

| Name | Kind | Setup | Result |
| --- | --- | --- | --- |
| twilio | source | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN | Recent calls with from, to, duration |
| call-file | source | --file with JSONL events | Local call events |
| d1-log | sink | CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN | Rows in call_attributions |
| stripe-billing | sink | STRIPE_SECRET_KEY, STRIPE_CUSTOMER_ID | One meter event per credited lead |
| file-log | sink | TRACKING_LOG_FILE or constructor file | Appended JSONL attributions |

Keys also accept constructor options on each adapter.
Network adapters accept `fetchFn` and `timeoutMs`.
Run `sources` to list names with key status.
Run `doctor` to check vendor reach before a live run.

The sample JSONL uses `callSid, from, to, direction, status, startedAt, durationSec`.
Only `from` and `to` are required. The source filters by `--to`, `--from`,
`--since`, and `--limit`. Blank lines are skipped.

The sample lines file maps each number to a campaign and a source.
Calls to unknown numbers get campaign `unassigned` and source `unknown`.
A matched call credits a lead when it has a duration above zero,
or when no duration is present. Number match ignores format
and compares the last digits.

## Twilio

Twilio lists calls and owned numbers through its REST API.
Pull reads recent inbound and outbound calls with Basic auth.
It accepts `--to`, `--from`, `--since`, and `--limit`.
Since filters by start date. Limit caps PageSize at 1000.

```sh
node dist/cli.js lines
node dist/cli.js attribute --source twilio --since 2026-05-01 --live
```

```js
import { TwilioSource } from "./dist/index.js";

const twilio = new TwilioSource();
console.log(await twilio.listLines());
console.log(await twilio.pull({ since: "2026-05-01", limit: 10 }));
```

Pass a line map to `listLines` to tag numbers with campaigns.
Without a map, every number reports `unassigned`.
Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN before a live call.

## D1 log

The D1 sink creates the table on first push, then upserts rows.
It sends one batch with CREATE TABLE IF NOT EXISTS plus one
INSERT OR REPLACE per attribution. Re-pushes stay idempotent
because call_sid is the primary key.

```js
import { D1Sink, runAttribution } from "./dist/index.js";

const result = await runAttribution({ lines: [] }, {
  sources: [],
  sinks: [new D1Sink()],
});
console.log(result);
```

Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID,
and CLOUDFLARE_API_TOKEN before a live call. The token needs D1 read
and write permission. The default table is `call_attributions`.
Pass `table` to use another name. Table names accept letters,
digits, and underscores only.

## Stripe billing

The Stripe sink sends one meter event per credited lead.
It skips uncredited calls and reports the skipped count.
Each event carries the call sid as its idempotency identifier,
so a retry never bills twice. It sends the call time when the time
falls inside the Stripe window, and omits it otherwise.

```js
import { StripeSink } from "./dist/index.js";

const sink = new StripeSink({ eventName: "credited_lead" });
console.log(await sink.push([]));
```

Set STRIPE_SECRET_KEY and STRIPE_CUSTOMER_ID before a live call.
Set STRIPE_EVENT_NAME to change the meter event name.
Create the meter with the same event name in the Stripe dashboard first.
Events send one by one because Stripe allows one concurrent call
per customer per meter.

## SDK

```js
import { FileSink, FileSource, runAttribution } from "./dist/index.js";

const preview = await runAttribution({
  query: { file: "examples/calls.jsonl" },
  lines: [{ number: "+15551230001", campaign: "summer-sale", source: "website" }],
  sources: [new FileSource()],
  sinks: [new FileSink({ file: "/tmp/attribution.jsonl" })],
}, { dryRun: true });
console.log(preview);
```

runAttribution accepts query, lines, sources, and sinks.
It checks guards before any vendor call and fans out live pulls.
It attributes the merged events, then fans out live pushes.
Each live source and sink call records a cost entry,
including zero units on failure. The SDK defaults to live mode;
set dryRun true to preview. The package re-exports the frozen
agentic-core API.

## MCP and worker

The `mcp` command and `agentic-tracking-mcp` bin serve stdio MCP.
Use attribute_calls with to, from, since, limit, file, lines,
source or sources, sink or sinks, and dryRun.
DryRun defaults to true. list_lines shows Twilio numbers
with an optional line map. list_sources shows key status.
get_cost_report reads session entries and unit totals.
.mcp.json configures agentic-tracking through npx.

The worker serves GET /health and POST /attribute.
Send to, from, since, limit, file, lines, source, sink, and live
in a JSON body. It previews unless live is true.
Local files require a Node filesystem.

## License

MIT. See LICENSE.
