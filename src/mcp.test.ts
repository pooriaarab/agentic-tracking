import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test, vi } from "vitest";
import { createMcpServer } from "./mcp.js";
import { createGuards } from "./core.js";
const textOf = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
test("MCP tools use injected sources and default to preview", async () => {
  const pull = vi.fn().mockResolvedValue([{ from: "a", to: "b" }]);
  const push = vi.fn().mockResolvedValue({ count: 1 });
  const listLines = vi.fn().mockResolvedValue([{ number: "b", campaign: "c", source: "s" }]);
  const [ct, st] = InMemoryTransport.createLinkedPair(); const server = createMcpServer({ sources: [{ name: "stub", pull }], sinks: [{ name: "log", push }], lineSource: { name: "twilio", pull, listLines } as never, guards: createGuards({ blocklist: ["denied"] }) }); const client = new Client({ name: "probe", version: "0.0.0" });
  await server.connect(st); await client.connect(ct);
  try {
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["attribute_calls", "get_cost_report", "list_lines", "list_sources"]);
    expect(textOf(await client.callTool({ name: "attribute_calls", arguments: { to: "b", sources: ["stub"] } }))).toMatchObject({ dryRun: true, sources: ["stub"] }); expect(pull).not.toHaveBeenCalled();
    expect(textOf(await client.callTool({ name: "attribute_calls", arguments: { to: "b", source: "stub", dryRun: false } }))).toMatchObject({ dryRun: false, sources: [{ ok: true }] }); expect(pull).toHaveBeenCalledOnce(); expect(push).toHaveBeenCalledOnce();
    expect(textOf(await client.callTool({ name: "list_lines", arguments: {} }))).toEqual([{ number: "b", campaign: "c", source: "s" }]);
    expect(textOf(await client.callTool({ name: "list_sources", arguments: {} }))).toEqual([{ name: "stub", kind: "source", keyRequired: false, keySet: false }, { name: "log", kind: "sink", keyRequired: false, keySet: false }]);
    expect(textOf(await client.callTool({ name: "get_cost_report", arguments: {} }))).toHaveProperty("entries");
    expect(await client.callTool({ name: "attribute_calls", arguments: { to: "denied" } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "attribute_calls", arguments: { to: "b", source: "unknown" } })).toMatchObject({ isError: true });
    pull.mockRejectedValue(new Error("down")); expect(await client.callTool({ name: "attribute_calls", arguments: { to: "b", dryRun: false } })).toMatchObject({ isError: true });
  } finally { await client.close(); await server.close(); }
});
test("list_lines routes to the Telnyx source on request", async () => {
  const twilioLines = vi.fn().mockResolvedValue([{ number: "a", campaign: "c", source: "twilio" }]);
  const telnyxLines = vi.fn().mockResolvedValue([{ number: "b", campaign: "c", source: "telnyx" }]);
  const [ct, st] = InMemoryTransport.createLinkedPair(); const server = createMcpServer({ lineSource: { listLines: twilioLines }, telnyxLineSource: { listLines: telnyxLines } }); const client = new Client({ name: "probe", version: "0.0.0" });
  await server.connect(st); await client.connect(ct);
  try {
    expect(textOf(await client.callTool({ name: "list_lines", arguments: { source: "telnyx" } }))).toEqual([{ number: "b", campaign: "c", source: "telnyx" }]);
    expect(telnyxLines).toHaveBeenCalledOnce(); expect(twilioLines).not.toHaveBeenCalled();
    expect(textOf(await client.callTool({ name: "list_lines", arguments: {} }))).toEqual([{ number: "a", campaign: "c", source: "twilio" }]);
    expect(twilioLines).toHaveBeenCalledOnce();
  } finally { await client.close(); await server.close(); }
});
