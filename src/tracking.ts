import { appendFile, readFile } from "node:fs/promises";
import { VendorError, recordCost, type Guards, type Logger } from "./core.js";

export interface CallEvent {
  callSid?: string;
  from: string;
  to: string;
  direction?: string;
  status?: string;
  startedAt?: string;
  durationSec?: number;
}
export interface CallQuery {
  to?: string;
  from?: string;
  since?: string;
  limit?: number;
  file?: string;
}
export interface TrackingLine {
  number: string;
  campaign: string;
  source: string;
  label?: string;
}
export interface Attribution {
  callSid: string;
  from: string;
  trackingNumber: string;
  campaign: string;
  source: string;
  creditedLead: boolean;
  durationSec: number;
  at: string;
}
export interface CallSource {
  name: string;
  pull(q: CallQuery): Promise<CallEvent[]>;
}
export interface SinkPushed {
  count: number;
  skipped?: number;
  id?: string;
}
export interface EventSink {
  name: string;
  push(a: Attribution[]): Promise<SinkPushed>;
}
export interface SourceResult {
  source: string;
  ok: boolean;
  events?: CallEvent[];
  error?: string;
}
export interface SinkResult {
  sink: string;
  ok: boolean;
  count?: number;
  skipped?: number;
  error?: string;
}
export interface CampaignTotal {
  campaign: string;
  calls: number;
  creditedLeads: number;
  minutes: number;
}
export interface AttributionSummary {
  calls: number;
  creditedLeads: number;
  minutes: number;
  byCampaign: CampaignTotal[];
  bySource: { source: string; calls: number; creditedLeads: number; minutes: number }[];
}
export type RunResult =
  | { dryRun: true; query: CallQuery; sources: string[]; sinks: string[]; lines: number }
  | { dryRun: false; attributions: Attribution[]; summary: AttributionSummary; sources: SourceResult[]; sinks: SinkResult[] };

function digits(value: string): string {
  return value.replace(/\D/g, "");
}
function sameNumber(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 7 || db.length < 7) return da === db && da.length > 0;
  return da.slice(-10) === db.slice(-10);
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function attributeCalls(events: CallEvent[], lines: TrackingLine[]): Attribution[] {
  return events.map((event, index) => {
    const line = lines.find(l => sameNumber(l.number, event.to));
    const durationSec = event.durationSec ?? 0;
    return {
      callSid: event.callSid?.trim() ? event.callSid.trim() : `local-${index + 1}`,
      from: event.from,
      trackingNumber: event.to,
      campaign: line?.campaign ?? "unassigned",
      source: line?.source ?? "unknown",
      creditedLead: !!line && (event.durationSec === undefined || event.durationSec > 0),
      durationSec,
      at: event.startedAt ?? new Date().toISOString(),
    };
  });
}

export function summarizeAttribution(attributions: Attribution[]): AttributionSummary {
  const minutesOf = (list: Attribution[]) => Math.round((list.reduce((sum, a) => sum + a.durationSec, 0) / 60) * 100) / 100;
  const groups = new Map<string, Attribution[]>();
  const sources = new Map<string, Attribution[]>();
  for (const a of attributions) {
    groups.set(a.campaign, [...(groups.get(a.campaign) ?? []), a]);
    sources.set(a.source, [...(sources.get(a.source) ?? []), a]);
  }
  const totals = (entries: Map<string, Attribution[]>) =>
    [...entries].map(([key, list]) => ({ key, calls: list.length, creditedLeads: list.filter(a => a.creditedLead).length, minutes: minutesOf(list) }));
  return {
    calls: attributions.length,
    creditedLeads: attributions.filter(a => a.creditedLead).length,
    minutes: minutesOf(attributions),
    byCampaign: totals(groups).map(t => ({ campaign: t.key, calls: t.calls, creditedLeads: t.creditedLeads, minutes: t.minutes })),
    bySource: totals(sources).map(t => ({ source: t.key, calls: t.calls, creditedLeads: t.creditedLeads, minutes: t.minutes })),
  };
}

export interface RunInput {
  query?: CallQuery;
  lines?: TrackingLine[];
  sources?: CallSource[];
  sinks?: EventSink[];
}
export interface RunOptions {
  guards?: Guards;
  logger?: Logger;
  dryRun?: boolean;
}
export async function runAttribution(input: RunInput = {}, options: RunOptions = {}): Promise<RunResult> {
  const query = input.query ?? {};
  const lines = input.lines ?? [];
  const sources = input.sources ?? defaultSources();
  const sinks = input.sinks ?? defaultSinks();
  options.guards?.checkDispatch(JSON.stringify(query));
  if (options.dryRun) {
    return { dryRun: true, query, sources: sources.map(s => s.name), sinks: sinks.map(s => s.name), lines: lines.length };
  }
  for (const adapter of [...sources, ...sinks]) {
    options.guards?.checkDispatch(adapter.name);
    options.guards?.recordDispatch();
    options.logger?.debug(`run via ${adapter.name}`);
  }
  const sourceResults = await Promise.all(
    sources.map(async source => {
      try {
        const events = await source.pull(query);
        recordCost({ kind: "pull", adapter: source.name, units: events.length });
        return { source: source.name, ok: true, events } as SourceResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.error(`${source.name}: ${message}`);
        recordCost({ kind: "pull", adapter: source.name, units: 0 });
        return { source: source.name, ok: false, error: message } as SourceResult;
      }
    }),
  );
  const attributions = attributeCalls(sourceResults.flatMap(r => r.events ?? []), lines);
  const summary = summarizeAttribution(attributions);
  const sinkResults = await Promise.all(
    sinks.map(async sink => {
      try {
        const pushed = await sink.push(attributions);
        recordCost({ kind: "push", adapter: sink.name, units: pushed.count });
        return { sink: sink.name, ok: true, count: pushed.count, skipped: pushed.skipped } as SinkResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.error(`${sink.name}: ${message}`);
        recordCost({ kind: "push", adapter: sink.name, units: 0 });
        return { sink: sink.name, ok: false, error: message } as SinkResult;
      }
    }),
  );
  return { dryRun: false, attributions, summary, sources: sourceResults, sinks: sinkResults };
}

export interface AdapterOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}
type Row = Record<string, unknown>;
function object(value: unknown, what: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VendorError(`bad payload (${what}: expected object)`);
  return value as Row;
}
function rows(value: unknown, what: string): Row[] {
  if (!Array.isArray(value)) throw new VendorError(`bad payload (${what}: expected array)`);
  return value.map(item => object(item, what));
}
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new VendorError(`bad payload (${what}: missing text)`);
  return value;
}
function base64(value: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
  return btoa(value);
}
abstract class RemoteAdapter {
  constructor(protected options: AdapterOptions = {}) {}
  protected async request(url: string, init: RequestInit, name: string, timeoutMs = this.options.timeoutMs ?? 10000): Promise<Response> {
    try {
      const response = await (this.options.fetchFn ?? fetch)(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new VendorError(`${name}: HTTP ${response.status}`, { status: response.status });
      return response;
    } catch (error) {
      if (error instanceof VendorError) throw error;
      throw new VendorError(`${name}: request failed`, { cause: error });
    }
  }
  protected async json(url: string, init: RequestInit, name: string): Promise<unknown> {
    const response = await this.request(url, init, name);
    try {
      return await response.json();
    } catch (error) {
      throw new VendorError(`${name}: bad payload (expected JSON)`, { cause: error });
    }
  }
}

export const TWILIO_BASE_URL = "https://api.twilio.com/2010-04-01";
export const TWILIO_SID_ENV = "TWILIO_ACCOUNT_SID";
export const TWILIO_TOKEN_ENV = "TWILIO_AUTH_TOKEN";
export interface TwilioOptions extends AdapterOptions {
  accountSid?: string;
  authToken?: string;
  baseUrl?: string;
}
function twilioDate(value: unknown): string {
  const raw = text(value, "call start");
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw new VendorError("twilio: bad payload (call start: bad date)");
  return new Date(time).toISOString();
}
function twilioDuration(value: unknown): number {
  if (value === "" || value === undefined || value === null) return 0;
  const seconds = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new VendorError("twilio: bad payload (call duration: bad number)");
  return seconds;
}
export class TwilioSource extends RemoteAdapter implements CallSource, LineSource {
  readonly name = "twilio";
  private twilioOptions: TwilioOptions;
  constructor(options: TwilioOptions = {}) {
    super(options);
    this.twilioOptions = options;
  }
  private auth(): { sid: string; headers: Record<string, string> } {
    const sid = this.twilioOptions.accountSid ?? process.env[TWILIO_SID_ENV];
    const token = this.twilioOptions.authToken ?? process.env[TWILIO_TOKEN_ENV];
    if (!sid?.trim() || !token?.trim()) throw new VendorError("twilio: missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    return { sid: sid.trim(), headers: { authorization: `Basic ${base64(`${sid.trim()}:${token.trim()}`)}` } };
  }
  async pull(q: CallQuery): Promise<CallEvent[]> {
    const { sid, headers } = this.auth();
    const parts = [`PageSize=${Math.min(Math.max(q.limit ?? 50, 1), 1000)}`];
    if (q.to?.trim()) parts.push(`To=${encodeURIComponent(q.to.trim())}`);
    if (q.from?.trim()) parts.push(`From=${encodeURIComponent(q.from.trim())}`);
    if (q.since?.trim()) {
      const time = Date.parse(q.since.trim());
      if (Number.isNaN(time)) throw new VendorError("twilio: bad since date");
      parts.push(`StartTime>=${new Date(time).toISOString().slice(0, 10)}`);
    }
    const base = this.twilioOptions.baseUrl ?? TWILIO_BASE_URL;
    const payload = object(
      await this.json(`${base}/Accounts/${encodeURIComponent(sid)}/Calls.json?${parts.join("&")}`, { headers }, "twilio"),
      "call list",
    );
    return rows(payload.calls, "call list").map(call => ({
      callSid: text(call.sid, "call sid"),
      from: text(call.from, "call from"),
      to: text(call.to, "call to"),
      direction: str(call.direction),
      status: str(call.status),
      startedAt: twilioDate(call.start_time ?? call.date_created),
      durationSec: twilioDuration(call.duration),
    }));
  }
  async listLines(lineMap: Record<string, { campaign: string; source: string }> = {}): Promise<TrackingLine[]> {
    const { sid, headers } = this.auth();
    const base = this.twilioOptions.baseUrl ?? TWILIO_BASE_URL;
    const payload = object(
      await this.json(`${base}/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=100`, { headers }, "twilio"),
      "number list",
    );
    return rows(payload.incoming_phone_numbers, "number list").map(entry => {
      const number = text(entry.phone_number, "number");
      const mapped = lineMap[number] ?? lineMap[digits(number)];
      return {
        number,
        campaign: mapped?.campaign ?? "unassigned",
        source: mapped?.source ?? "twilio",
        label: str(entry.friendly_name),
      };
    });
  }
}

export const TELNYX_BASE_URL = "https://api.telnyx.com/v2";
export const TELNYX_API_KEY_ENV = "TELNYX_API_KEY";
export const TELNYX_RECORD_TYPE = "call-control";
export interface TelnyxOptions extends AdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  recordType?: string;
}
export interface LineSource {
  listLines(lineMap?: Record<string, { campaign: string; source: string }>): Promise<TrackingLine[]>;
}
function telnyxDate(value: unknown): string {
  const raw = text(value, "record start");
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw new VendorError("telnyx: bad payload (record start: bad date)");
  return new Date(time).toISOString();
}
function telnyxDuration(value: unknown): number {
  const seconds = num(value);
  if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < 0) throw new VendorError("telnyx: bad payload (record duration: bad number)");
  return seconds;
}
export class TelnyxSource extends RemoteAdapter implements CallSource, LineSource {
  readonly name = "telnyx";
  private telnyxOptions: TelnyxOptions;
  constructor(options: TelnyxOptions = {}) {
    super(options);
    this.telnyxOptions = options;
  }
  private headers(): Record<string, string> {
    const key = this.telnyxOptions.apiKey ?? process.env[TELNYX_API_KEY_ENV];
    if (!key?.trim()) throw new VendorError("telnyx: missing TELNYX_API_KEY");
    return { authorization: `Bearer ${key.trim()}` };
  }
  async pull(q: CallQuery): Promise<CallEvent[]> {
    const headers = this.headers();
    const recordType = (this.telnyxOptions.recordType ?? TELNYX_RECORD_TYPE).trim();
    if (!recordType) throw new VendorError("telnyx: missing record type");
    const params = new URLSearchParams();
    params.set("filter[record_type]", recordType);
    params.set("sort", "-created_at");
    params.set("page[size]", String(Math.min(Math.max(q.limit ?? 50, 1), 50)));
    if (q.since?.trim()) {
      const time = Date.parse(q.since.trim());
      if (Number.isNaN(time)) throw new VendorError("telnyx: bad since date");
      params.set("filter[created_at][gte]", new Date(time).toISOString());
    }
    const base = this.telnyxOptions.baseUrl ?? TELNYX_BASE_URL;
    const payload = object(
      await this.json(`${base}/detail_records?${params}`, { headers }, "telnyx"),
      "record list",
    );
    return rows(payload.data, "record list")
      .map(record => ({
        callSid: str(record.id),
        from: text(record.cli, "record cli"),
        to: text(record.cld, "record cld"),
        direction: str(record.direction),
        startedAt: telnyxDate(record.started_at),
        durationSec: telnyxDuration(record.call_sec),
      }))
      .filter(e => (!q.to?.trim() || sameNumber(e.to, q.to)) && (!q.from?.trim() || sameNumber(e.from, q.from)));
  }
  async listLines(lineMap: Record<string, { campaign: string; source: string }> = {}): Promise<TrackingLine[]> {
    const headers = this.headers();
    const base = this.telnyxOptions.baseUrl ?? TELNYX_BASE_URL;
    const payload = object(
      await this.json(`${base}/phone_numbers?page[size]=100`, { headers }, "telnyx"),
      "number list",
    );
    return rows(payload.data, "number list").map(entry => {
      const number = text(entry.phone_number, "number");
      const mapped = lineMap[number] ?? lineMap[digits(number)];
      return {
        number,
        campaign: mapped?.campaign ?? "unassigned",
        source: mapped?.source ?? "telnyx",
        label: str(entry.friendly_name),
      };
    });
  }
}

export interface FileSourceOptions extends AdapterOptions {
  file?: string;
}
export class FileSource implements CallSource {
  readonly name = "call-file";
  constructor(private options: FileSourceOptions = {}) {}
  async pull(q: CallQuery): Promise<CallEvent[]> {
    const file = q.file ?? this.options.file;
    if (!file?.trim()) throw new VendorError("call-file: missing file");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      throw new VendorError("call-file: cannot read file", { cause: error });
    }
    let since = 0;
    if (q.since?.trim()) {
      since = Date.parse(q.since.trim());
      if (Number.isNaN(since)) throw new VendorError("call-file: bad since date");
    }
    const events: CallEvent[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new VendorError(`call-file: bad JSON on line ${index + 1}`);
      }
      const row = object(parsed, `call-file line ${index + 1}`);
      const from = str(row.from);
      const to = str(row.to);
      if (!from?.trim() || !to?.trim()) throw new VendorError(`call-file: line ${index + 1} needs from and to`);
      const startedAt = str(row.startedAt ?? row.started_at);
      if (startedAt !== undefined && Number.isNaN(Date.parse(startedAt))) throw new VendorError(`call-file: line ${index + 1} carries a bad date`);
      const duration = row.durationSec ?? row.duration_sec;
      const seconds = duration === undefined ? undefined : num(duration);
      if (duration !== undefined && (seconds === undefined || seconds < 0)) throw new VendorError(`call-file: line ${index + 1} carries a bad duration`);
      events.push({
        callSid: str(row.callSid ?? row.call_sid),
        from: from.trim(),
        to: to.trim(),
        direction: str(row.direction),
        status: str(row.status),
        startedAt,
        durationSec: seconds,
      });
    }
    return events
      .filter(e => (!q.to?.trim() || sameNumber(e.to, q.to)) && (!q.from?.trim() || sameNumber(e.from, q.from)))
      .filter(e => !since || (e.startedAt !== undefined && Date.parse(e.startedAt) >= since))
      .slice(0, q.limit);
  }
}

export const D1_BASE_URL = "https://api.cloudflare.com/client/v4";
export const D1_TABLE = "call_attributions";
function d1Table(name: string | undefined): string {
  const table = (name ?? D1_TABLE).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new VendorError("d1-log: bad table name");
  return table;
}
export interface D1Options extends AdapterOptions {
  accountId?: string;
  databaseId?: string;
  apiToken?: string;
  table?: string;
  baseUrl?: string;
}
export class D1Sink extends RemoteAdapter implements EventSink {
  readonly name = "d1-log";
  private d1Options: D1Options;
  constructor(options: D1Options = {}) {
    super(options);
    this.d1Options = options;
  }
  async push(attributions: Attribution[]): Promise<SinkPushed> {
    const o = this.d1Options;
    const accountId = o.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    const databaseId = o.databaseId ?? process.env.CLOUDFLARE_D1_DATABASE_ID;
    const token = o.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId?.trim() || !databaseId?.trim() || !token?.trim()) {
      throw new VendorError("d1-log: missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, or CLOUDFLARE_API_TOKEN");
    }
    const table = d1Table(o.table);
    const base = o.baseUrl ?? D1_BASE_URL;
    const batch = [
      {
        sql: `CREATE TABLE IF NOT EXISTS ${table} (call_sid TEXT PRIMARY KEY, caller TEXT, tracking_number TEXT, campaign TEXT, source TEXT, credited_lead INTEGER, duration_sec INTEGER, at TEXT)`,
        params: [],
      },
      ...attributions.map(a => ({
        sql: `INSERT OR REPLACE INTO ${table} (call_sid, caller, tracking_number, campaign, source, credited_lead, duration_sec, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [a.callSid, a.from, a.trackingNumber, a.campaign, a.source, a.creditedLead ? 1 : 0, a.durationSec, a.at],
      })),
    ];
    const payload = object(
      await this.json(
        `${base}/accounts/${encodeURIComponent(accountId.trim())}/d1/database/${encodeURIComponent(databaseId.trim())}/query`,
        { method: "POST", headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" }, body: JSON.stringify({ batch }) },
        "d1-log",
      ),
      "d1 query",
    );
    if (payload.success !== true) {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const first = errors.length && typeof errors[0] === "object" && errors[0] !== null ? str((errors[0] as Row).message) : undefined;
      throw new VendorError(`d1-log: query failed${first ? `: ${first}` : ""}`);
    }
    if (!Array.isArray(payload.result)) throw new VendorError("d1-log: bad payload (expected result array)");
    return { count: attributions.length };
  }
}

export const STRIPE_BASE_URL = "https://api.stripe.com/v1";
export const STRIPE_EVENT_NAME = "credited_lead";
export interface StripeOptions extends AdapterOptions {
  secretKey?: string;
  customerId?: string;
  eventName?: string;
  baseUrl?: string;
}
function stripeTimestamp(at: string): number | undefined {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return undefined;
  const now = Date.now();
  if (time < now - 35 * 24 * 3600 * 1000 || time > now + 5 * 60 * 1000) return undefined;
  return Math.floor(time / 1000);
}
export class StripeSink extends RemoteAdapter implements EventSink {
  readonly name = "stripe-billing";
  private stripeOptions: StripeOptions;
  constructor(options: StripeOptions = {}) {
    super(options);
    this.stripeOptions = options;
  }
  async push(attributions: Attribution[]): Promise<SinkPushed> {
    const o = this.stripeOptions;
    const key = o.secretKey ?? process.env.STRIPE_SECRET_KEY;
    const customer = o.customerId ?? process.env.STRIPE_CUSTOMER_ID;
    if (!key?.trim()) throw new VendorError("stripe-billing: missing STRIPE_SECRET_KEY");
    if (!customer?.trim()) throw new VendorError("stripe-billing: missing STRIPE_CUSTOMER_ID");
    const eventName = (o.eventName ?? process.env.STRIPE_EVENT_NAME ?? STRIPE_EVENT_NAME).trim();
    if (!eventName) throw new VendorError("stripe-billing: missing event name");
    const base = o.baseUrl ?? STRIPE_BASE_URL;
    const headers = { authorization: `Basic ${base64(`${key.trim()}:`)}`, "content-type": "application/x-www-form-urlencoded" };
    const credited = attributions.filter(a => a.creditedLead);
    for (const a of credited) {
      const form = new URLSearchParams();
      form.set("event_name", eventName);
      form.set("identifier", a.callSid);
      form.set("payload[value]", "1");
      form.set("payload[stripe_customer_id]", customer.trim());
      const timestamp = stripeTimestamp(a.at);
      if (timestamp !== undefined) form.set("timestamp", String(timestamp));
      const payload = object(await this.json(`${base}/billing/meter_events`, { method: "POST", headers, body: form.toString() }, "stripe-billing"), "meter event");
      if (payload.identifier !== a.callSid) throw new VendorError("stripe-billing: bad payload (identifier mismatch)");
    }
    return { count: credited.length, skipped: attributions.length - credited.length };
  }
}

export const FILE_LOG_ENV = "TRACKING_LOG_FILE";
export interface FileSinkOptions {
  file?: string;
}
export class FileSink implements EventSink {
  readonly name = "file-log";
  constructor(private options: FileSinkOptions = {}) {}
  async push(attributions: Attribution[]): Promise<SinkPushed> {
    const file = this.options.file ?? process.env[FILE_LOG_ENV];
    if (!file?.trim()) throw new VendorError("file-log: missing file");
    try {
      if (attributions.length) await appendFile(file, `${attributions.map(a => JSON.stringify(a)).join("\n")}\n`, "utf8");
      return { count: attributions.length };
    } catch (error) {
      throw new VendorError("file-log: cannot write file", { cause: error });
    }
  }
}

export function defaultSources(): CallSource[] {
  return [new TwilioSource(), new TelnyxSource(), new FileSource()];
}
export function defaultSinks(): EventSink[] {
  return [new D1Sink(), new StripeSink(), new FileSink()];
}
export function selectSources(sources: CallSource[], name = "all"): CallSource[] {
  if (name === "all") return sources;
  const selected = sources.filter(s => s.name === name);
  if (!selected.length) throw new VendorError(`unknown source: ${name}`);
  return selected;
}
export function selectSinks(sinks: EventSink[], name = "all"): EventSink[] {
  if (name === "all") return sinks;
  const selected = sinks.filter(s => s.name === name);
  if (!selected.length) throw new VendorError(`unknown sink: ${name}`);
  return selected;
}
export interface SourceStatus {
  name: string;
  kind: "source" | "sink";
  keyRequired: boolean;
  keySet: boolean;
}
const SOURCE_KEYS: Record<string, string[]> = {
  twilio: [TWILIO_SID_ENV, TWILIO_TOKEN_ENV],
  telnyx: [TELNYX_API_KEY_ENV],
  "d1-log": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"],
  "stripe-billing": ["STRIPE_SECRET_KEY", "STRIPE_CUSTOMER_ID"],
};
export function listSources(sources: CallSource[] = defaultSources(), sinks: EventSink[] = defaultSinks()): SourceStatus[] {
  return [...sources.map(s => ({ name: s.name, kind: "source" as const })), ...sinks.map(s => ({ name: s.name, kind: "sink" as const }))].map(entry => {
    const keys = SOURCE_KEYS[entry.name] ?? [];
    return { name: entry.name, kind: entry.kind, keyRequired: keys.length > 0, keySet: keys.length > 0 && keys.every(k => !!process.env[k]?.trim()) };
  });
}

export async function readLinesFile(path: string): Promise<TrackingLine[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new VendorError("lines: cannot read file", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VendorError("lines: bad JSON");
  }
  return rows(parsed, "lines file").map((row, index) => {
    const number = str(row.number);
    const campaign = str(row.campaign);
    const source = str(row.source);
    if (!number?.trim() || !campaign?.trim() || !source?.trim()) throw new VendorError(`lines: entry ${index + 1} needs number, campaign, and source`);
    return { number: number.trim(), campaign: campaign.trim(), source: source.trim(), label: str(row.label) };
  });
}

export interface DoctorCheck {
  ok: boolean;
  error?: string;
}
export interface DoctorReport {
  twilio: DoctorCheck;
  telnyx: DoctorCheck;
  d1: DoctorCheck;
  stripe: DoctorCheck;
}
export interface DoctorOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  twilioSid?: string;
  twilioToken?: string;
  telnyxKey?: string;
  d1AccountId?: string;
  d1DatabaseId?: string;
  d1Token?: string;
  stripeKey?: string;
}
async function check(name: string, run: () => Promise<void>): Promise<DoctorCheck> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.replace(`${name}: `, "") : String(error) };
  }
}
export async function readDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  const call = async (url: string, init: RequestInit, name: string): Promise<Response> => {
    try {
      const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new VendorError(`${name}: HTTP ${response.status}`, { status: response.status });
      return response;
    } catch (error) {
      if (error instanceof VendorError) throw error;
      throw new VendorError(`${name}: request failed`, { cause: error });
    }
  };
  const sid = options.twilioSid ?? process.env[TWILIO_SID_ENV];
  const token = options.twilioToken ?? process.env[TWILIO_TOKEN_ENV];
  const twilio = await check("twilio", async () => {
    if (!sid?.trim() || !token?.trim()) throw new VendorError("twilio: missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    await call(`${TWILIO_BASE_URL}/Accounts/${encodeURIComponent(sid.trim())}.json`, { headers: { authorization: `Basic ${base64(`${sid.trim()}:${token.trim()}`)}` } }, "twilio");
  });
  const telnyxKey = options.telnyxKey ?? process.env[TELNYX_API_KEY_ENV];
  const telnyx = await check("telnyx", async () => {
    if (!telnyxKey?.trim()) throw new VendorError("telnyx: missing TELNYX_API_KEY");
    await call(`${TELNYX_BASE_URL}/phone_numbers?page[size]=1`, { headers: { authorization: `Bearer ${telnyxKey.trim()}` } }, "telnyx");
  });
  const accountId = options.d1AccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = options.d1DatabaseId ?? process.env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = options.d1Token ?? process.env.CLOUDFLARE_API_TOKEN;
  const d1 = await check("d1-log", async () => {
    if (!accountId?.trim() || !databaseId?.trim() || !apiToken?.trim()) throw new VendorError("d1-log: missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, or CLOUDFLARE_API_TOKEN");
    const response = await call(
      `${D1_BASE_URL}/accounts/${encodeURIComponent(accountId.trim())}/d1/database/${encodeURIComponent(databaseId.trim())}/query`,
      { method: "POST", headers: { authorization: `Bearer ${apiToken.trim()}`, "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1", params: [] }) },
      "d1-log",
    );
    const payload = object(await response.json(), "d1 check");
    if (payload.success !== true) throw new VendorError("d1-log: query failed");
  });
  const stripeKey = options.stripeKey ?? process.env.STRIPE_SECRET_KEY;
  const stripe = await check("stripe-billing", async () => {
    if (!stripeKey?.trim()) throw new VendorError("stripe-billing: missing STRIPE_SECRET_KEY");
    await call(`${STRIPE_BASE_URL}/balance`, { headers: { authorization: `Basic ${base64(`${stripeKey.trim()}:`)}` } }, "stripe-billing");
  });
  return { twilio, telnyx, d1, stripe };
}
