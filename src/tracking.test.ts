import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGuards, getCostReport, resetCosts, VendorError } from "./core.js";
import {
  attributeCalls,
  D1Sink,
  FileSink,
  FileSource,
  listSources,
  readDoctor,
  readLinesFile,
  runAttribution,
  selectSinks,
  selectSources,
  StripeSink,
  summarizeAttribution,
  TwilioSource,
  type Attribution,
} from "./tracking.js";

const json = (value: unknown) => new Response(JSON.stringify(value));
const lines = [
  { number: "+15551230001", campaign: "summer-sale", source: "website", label: "Site line" },
  { number: "5551230002", campaign: "flyer", source: "print" },
];
afterEach(() => { vi.unstubAllEnvs(); resetCosts(); });

describe("attributeCalls", () => {
  test("matches numbers across formats and credits answered calls", () => {
    const result = attributeCalls(
      [
        { callSid: "CA1", from: "+15550001111", to: "+1 (555) 123-0001", durationSec: 61, startedAt: "2026-05-01T10:00:00.000Z" },
        { from: "+15550002222", to: "+15551230002", durationSec: 0 },
        { from: "+15550003333", to: "+15559998888", durationSec: 30 },
      ],
      lines,
    );
    expect(result[0]).toMatchObject({ callSid: "CA1", campaign: "summer-sale", source: "website", creditedLead: true, durationSec: 61, at: "2026-05-01T10:00:00.000Z" });
    expect(result[1]).toMatchObject({ callSid: "local-2", campaign: "flyer", source: "print", creditedLead: false });
    expect(result[2]).toMatchObject({ campaign: "unassigned", source: "unknown", creditedLead: false });
  });
  test("credits matched calls with unknown duration", () => {
    const [one] = attributeCalls([{ from: "a", to: "+15551230001" }], lines);
    expect(one.creditedLead).toBe(true);
    expect(one.durationSec).toBe(0);
  });
});

describe("summarizeAttribution", () => {
  test("totals calls, leads, and minutes by campaign and source", () => {
    const summary = summarizeAttribution(attributeCalls(
      [
        { from: "a", to: "+15551230001", durationSec: 60 },
        { from: "b", to: "+15551230001", durationSec: 120 },
        { from: "c", to: "+15559998888", durationSec: 30 },
      ],
      lines,
    ));
    expect(summary).toMatchObject({ calls: 3, creditedLeads: 2, minutes: 3.5 });
    expect(summary.byCampaign).toContainEqual({ campaign: "summer-sale", calls: 2, creditedLeads: 2, minutes: 3 });
    expect(summary.bySource).toContainEqual({ source: "unknown", calls: 1, creditedLeads: 0, minutes: 0.5 });
  });
});

describe("twilio", () => {
  const callPayload = { calls: [{ sid: "CA1", from: "+15550001111", to: "+15551230001", direction: "inbound", status: "completed", start_time: "Fri, 01 May 2026 10:00:00 +0000", duration: "61" }] };
  test("pulls calls with basic auth and maps fields", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(callPayload));
    const events = await new TwilioSource({ accountSid: "AC1", authToken: "tok", fetchFn }).pull({ to: "+15551230001", since: "2026-05-01", limit: 5 });
    expect(events).toEqual([{ callSid: "CA1", from: "+15550001111", to: "+15551230001", direction: "inbound", status: "completed", startedAt: "2026-05-01T10:00:00.000Z", durationSec: 61 }]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json?PageSize=5&To=%2B15551230001&StartTime>=2026-05-01");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  test("lists numbers and merges the line map", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ incoming_phone_numbers: [{ phone_number: "+15551230001", friendly_name: "Site" }, { phone_number: "+15551230009" }] }));
    const result = await new TwilioSource({ accountSid: "AC1", authToken: "tok", fetchFn }).listLines({ "+15551230001": { campaign: "summer-sale", source: "website" } });
    expect(result).toEqual([
      { number: "+15551230001", campaign: "summer-sale", source: "website", label: "Site" },
      { number: "+15551230009", campaign: "unassigned", source: "twilio", label: undefined },
    ]);
    expect(fetchFn.mock.calls[0][0]).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/IncomingPhoneNumbers.json?PageSize=100");
  });
  test("rejects missing creds before any fetch", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const fetchFn = vi.fn();
    await expect(new TwilioSource({ fetchFn }).pull({})).rejects.toBeInstanceOf(VendorError);
    await expect(new TwilioSource({ fetchFn }).listLines()).rejects.toBeInstanceOf(VendorError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  test.each(["http", "network", "payload", "since"])("rejects %s failures", async mode => {
    const fetchFn = mode === "network"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(mode === "http" ? new Response("", { status: 500 }) : json({}));
    const source = new TwilioSource({ accountSid: "AC1", authToken: "tok", fetchFn });
    await expect(source.pull(mode === "since" ? { since: "not-a-date" } : {})).rejects.toBeInstanceOf(VendorError);
    if (mode === "since") expect(fetchFn).not.toHaveBeenCalled();
  });
  test("rejects bad call fields", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ calls: [{ sid: "CA1" }] }));
    await expect(new TwilioSource({ accountSid: "AC1", authToken: "tok", fetchFn }).pull({})).rejects.toBeInstanceOf(VendorError);
  });
  test("rejects bad dates and durations", async () => {
    const bad = (call: unknown) => new TwilioSource({ accountSid: "AC1", authToken: "tok", fetchFn: vi.fn<typeof fetch>().mockResolvedValue(json({ calls: [call] })) }).pull({});
    await expect(bad({ sid: "CA1", from: "a", to: "b", start_time: "never", duration: "3" })).rejects.toBeInstanceOf(VendorError);
    await expect(bad({ sid: "CA1", from: "a", to: "b", start_time: "Fri, 01 May 2026 10:00:00 +0000", duration: "-2" })).rejects.toBeInstanceOf(VendorError);
  });
});

describe("call file", () => {
  const write = async (text: string) => {
    const dir = await mkdtemp(join(tmpdir(), "tracking-"));
    const file = join(dir, "calls.jsonl");
    await writeFile(file, text);
    return { dir, file };
  };
  test("parses JSONL, filters, and limits", async () => {
    const { dir, file } = await write(
      '{"callSid":"CA1","from":"+15550001111","to":"+15551230001","startedAt":"2026-05-01T10:00:00.000Z","durationSec":61}\n\n{"from":"+15550002222","to":"+15551230002","startedAt":"2026-06-01T10:00:00.000Z"}\n',
    );
    try {
      const source = new FileSource({ file });
      expect(await source.pull({})).toHaveLength(2);
      expect(await source.pull({ to: "5551230001" })).toHaveLength(1);
      expect(await source.pull({ since: "2026-06-01T00:00:00.000Z" })).toHaveLength(1);
      expect(await source.pull({ limit: 1 })).toHaveLength(1);
    } finally { await rm(dir, { recursive: true }); }
  });
  test("rejects bad rows, dates, and files", async () => {
    const { dir, file } = await write('{"from":"a"}\n');
    try {
      await expect(new FileSource({ file }).pull({})).rejects.toBeInstanceOf(VendorError);
      await expect(new FileSource({ file: join(dir, "missing.jsonl") }).pull({})).rejects.toBeInstanceOf(VendorError);
      await expect(new FileSource().pull({})).rejects.toBeInstanceOf(VendorError);
      await expect(new FileSource({ file }).pull({ since: "bad" })).rejects.toBeInstanceOf(VendorError);
    } finally { await rm(dir, { recursive: true }); }
    const broken = await write('{"from":\n');
    try { await expect(new FileSource({ file: broken.file }).pull({})).rejects.toBeInstanceOf(VendorError); }
    finally { await rm(broken.dir, { recursive: true }); }
  });
});

describe("d1-log", () => {
  const options = { accountId: "acct", databaseId: "db", apiToken: "token", fetchFn: vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, errors: [], result: [{}, {}] })) };
  const attribution: Attribution = { callSid: "CA1", from: "+15550001111", trackingNumber: "+15551230001", campaign: "summer-sale", source: "website", creditedLead: true, durationSec: 61, at: "2026-05-01T10:00:00.000Z" };
  test("creates the table and upserts rows in one batch", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, errors: [], result: [{}, {}] }));
    const pushed = await new D1Sink({ accountId: "acct", databaseId: "db", apiToken: "token", fetchFn }).push([attribution]);
    expect(pushed).toEqual({ count: 1 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
    const body = JSON.parse(init?.body as string);
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0].sql).toContain("CREATE TABLE IF NOT EXISTS call_attributions");
    expect(body.batch[1].sql).toContain("INSERT OR REPLACE INTO call_attributions");
    expect(body.batch[1].params).toEqual(["CA1", "+15550001111", "+15551230001", "summer-sale", "website", 1, 61, "2026-05-01T10:00:00.000Z"]);
  });
  test("rejects missing ids and token before any fetch", async () => {
    for (const env of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"]) vi.stubEnv(env, "");
    const fetchFn = vi.fn();
    await expect(new D1Sink({ fetchFn }).push([attribution])).rejects.toBeInstanceOf(VendorError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  test("rejects bad table names", async () => {
    await expect(new D1Sink({ ...options, table: "drop;table" }).push([attribution])).rejects.toBeInstanceOf(VendorError);
  });
  test.each(["http", "network", "envelope", "result"])("rejects %s failures", async mode => {
    const fetchFn = mode === "network"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(mode === "http" ? new Response("", { status: 500 }) : json(mode === "envelope" ? { success: false, errors: [{ message: "nope" }], result: [] } : { success: true, errors: [], result: {} }));
    await expect(new D1Sink({ accountId: "acct", databaseId: "db", apiToken: "token", fetchFn }).push([attribution])).rejects.toBeInstanceOf(VendorError);
  });
  test("reports the vendor error message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ success: false, errors: [{ message: "nope" }], result: [] }));
    await expect(new D1Sink({ accountId: "acct", databaseId: "db", apiToken: "token", fetchFn }).push([attribution])).rejects.toThrow("nope");
  });
});

describe("stripe-billing", () => {
  const credited: Attribution = { callSid: "CA1", from: "a", trackingNumber: "b", campaign: "summer-sale", source: "website", creditedLead: true, durationSec: 61, at: new Date().toISOString() };
  const uncredited: Attribution = { ...credited, callSid: "CA2", creditedLead: false };
  test("sends one meter event per credited lead with the call sid as identifier", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ object: "billing.meter_event", identifier: "CA1" }));
    const pushed = await new StripeSink({ secretKey: "sk", customerId: "cus_1", fetchFn }).push([credited, uncredited]);
    expect(pushed).toEqual({ count: 1, skipped: 1 });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/billing/meter_events");
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("event_name")).toBe("credited_lead");
    expect(form.get("identifier")).toBe("CA1");
    expect(form.get("payload[value]")).toBe("1");
    expect(form.get("payload[stripe_customer_id]")).toBe("cus_1");
    expect(form.get("timestamp")).toBe(String(Math.floor(Date.parse(credited.at) / 1000)));
  });
  test("omits stale timestamps and honors a custom event name", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ object: "billing.meter_event", identifier: "CA9" }));
    const old = { ...credited, callSid: "CA9", at: "2020-01-01T00:00:00.000Z" };
    await new StripeSink({ secretKey: "sk", customerId: "cus_1", eventName: "lead", fetchFn }).push([old]);
    const form = new URLSearchParams(fetchFn.mock.calls[0][1]?.body as string);
    expect(form.get("event_name")).toBe("lead");
    expect(form.get("timestamp")).toBeNull();
  });
  test("rejects missing key and customer before any fetch", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_CUSTOMER_ID", "");
    const fetchFn = vi.fn();
    await expect(new StripeSink({ fetchFn }).push([credited])).rejects.toBeInstanceOf(VendorError);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(new StripeSink({ secretKey: "sk", fetchFn }).push([credited])).rejects.toBeInstanceOf(VendorError);
  });
  test.each(["http", "network", "payload", "identifier"])("rejects %s failures", async mode => {
    const fetchFn = mode === "network"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(mode === "http" ? new Response("", { status: 500 }) : json(mode === "identifier" ? { object: "billing.meter_event", identifier: "other" } : {}));
    await expect(new StripeSink({ secretKey: "sk", customerId: "cus_1", fetchFn }).push([credited])).rejects.toBeInstanceOf(VendorError);
  });
});

describe("file-log", () => {
  const attribution: Attribution = { callSid: "CA1", from: "a", trackingNumber: "b", campaign: "c", source: "s", creditedLead: true, durationSec: 60, at: "2026-05-01T10:00:00.000Z" };
  test("appends attributions as JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tracking-"));
    try {
      const file = join(dir, "log.jsonl");
      expect(await new FileSink({ file }).push([attribution])).toEqual({ count: 1 });
      expect(await new FileSink({ file }).push([attribution])).toEqual({ count: 1 });
      const { readFile } = await import("node:fs/promises");
      expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally { await rm(dir, { recursive: true }); }
  });
  test("rejects a missing file", async () => {
    vi.stubEnv("TRACKING_LOG_FILE", "");
    await expect(new FileSink().push([attribution])).rejects.toBeInstanceOf(VendorError);
  });
});

describe("lines file", () => {
  test("reads and validates tracking lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tracking-"));
    try {
      const file = join(dir, "lines.json");
      await writeFile(file, JSON.stringify([{ number: "+15551230001", campaign: "summer-sale", source: "website", label: "Site" }]));
      expect(await readLinesFile(file)).toEqual([{ number: "+15551230001", campaign: "summer-sale", source: "website", label: "Site" }]);
      await writeFile(file, "[{]");
      await expect(readLinesFile(file)).rejects.toBeInstanceOf(VendorError);
      await writeFile(file, JSON.stringify([{ number: "x" }]));
      await expect(readLinesFile(file)).rejects.toBeInstanceOf(VendorError);
      await expect(readLinesFile(join(dir, "missing.json"))).rejects.toBeInstanceOf(VendorError);
    } finally { await rm(dir, { recursive: true }); }
  });
});

describe("selectors", () => {
  test("selects sources and sinks by name", async () => {
    const sources = [{ name: "twilio", pull: async () => [] }, { name: "call-file", pull: async () => [] }];
    const sinks = [{ name: "d1-log", push: async () => ({ count: 0 }) }];
    expect(selectSources(sources)).toHaveLength(2);
    expect(selectSources(sources, "twilio")).toHaveLength(1);
    expect(() => selectSources(sources, "bogus")).toThrow(VendorError);
    expect(selectSinks(sinks, "d1-log")).toHaveLength(1);
    expect(() => selectSinks(sinks, "bogus")).toThrow(VendorError);
  });
  test("lists key status for sources and sinks", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const status = listSources([{ name: "twilio", pull: async () => [] }], [{ name: "d1-log", push: async () => ({ count: 0 }) }]);
    expect(status).toEqual([
      { name: "twilio", kind: "source", keyRequired: true, keySet: true },
      { name: "d1-log", kind: "sink", keyRequired: true, keySet: false },
    ]);
  });
});

describe("runAttribution", () => {
  const event = { callSid: "CA1", from: "a", to: "+15551230001", durationSec: 60 };
  test("preview calls nothing and records no cost", async () => {
    const pull = vi.fn();
    const push = vi.fn();
    const result = await runAttribution({ query: { to: "x" }, lines, sources: [{ name: "twilio", pull }], sinks: [{ name: "d1-log", push }] }, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, sources: ["twilio"], sinks: ["d1-log"], lines: 2 });
    expect(pull).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(getCostReport().entries).toEqual([]);
  });
  test("guard blocks all calls", async () => {
    const pull = vi.fn();
    await expect(runAttribution({ sources: [{ name: "twilio", pull }] }, { guards: createGuards({ blocklist: ["twilio"] }) })).rejects.toThrow();
    expect(pull).not.toHaveBeenCalled();
  });
  test("fans out and isolates failures with one cost entry per call", async () => {
    resetCosts();
    const result = await runAttribution({ lines, sources: [{ name: "yes", pull: async () => [event] }, { name: "no", pull: async () => { throw new VendorError("down"); } }], sinks: [{ name: "log", push: async () => ({ count: 1 }) }] });
    expect(result).toMatchObject({ dryRun: false, sources: [{ source: "yes", ok: true }, { source: "no", ok: false, error: "down" }], sinks: [{ sink: "log", ok: true, count: 1 }] });
    if (!result.dryRun) {
      expect(result.attributions).toHaveLength(1);
      expect(result.summary).toMatchObject({ calls: 1, creditedLeads: 1 });
    }
    expect(getCostReport().entries).toEqual([
      expect.objectContaining({ kind: "pull", adapter: "yes", units: 1 }),
      expect.objectContaining({ kind: "pull", adapter: "no", units: 0 }),
      expect.objectContaining({ kind: "push", adapter: "log", units: 1 }),
    ]);
  });
});

describe("readDoctor", () => {
  test("reports missing creds without network calls", async () => {
    for (const env of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN", "STRIPE_SECRET_KEY"]) vi.stubEnv(env, "");
    const fetchFn = vi.fn();
    const report = await readDoctor({ fetchFn });
    expect(report).toEqual({
      twilio: { ok: false, error: "missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN" },
      d1: { ok: false, error: "missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, or CLOUDFLARE_API_TOKEN" },
      stripe: { ok: false, error: "missing STRIPE_SECRET_KEY" },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  test("checks each vendor endpoint", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ sid: "AC1" }))
      .mockResolvedValueOnce(json({ success: true, errors: [], result: [{}] }))
      .mockResolvedValueOnce(json({ object: "balance" }));
    const report = await readDoctor({ fetchFn, twilioSid: "AC1", twilioToken: "tok", d1AccountId: "a", d1DatabaseId: "d", d1Token: "t", stripeKey: "sk" });
    expect(report).toEqual({ twilio: { ok: true }, d1: { ok: true }, stripe: { ok: true } });
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual([
      "https://api.twilio.com/2010-04-01/Accounts/AC1.json",
      "https://api.cloudflare.com/client/v4/accounts/a/d1/database/d/query",
      "https://api.stripe.com/v1/balance",
    ]);
  });
  test("isolates one vendor failure", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json({ success: false, errors: [], result: [] }))
      .mockRejectedValueOnce(new Error("offline"));
    const report = await readDoctor({ fetchFn, twilioSid: "AC1", twilioToken: "tok", d1AccountId: "a", d1DatabaseId: "d", d1Token: "t", stripeKey: "sk" });
    expect(report.twilio).toMatchObject({ ok: false });
    expect(report.d1).toMatchObject({ ok: false });
    expect(report.stripe).toMatchObject({ ok: false });
  });
});
