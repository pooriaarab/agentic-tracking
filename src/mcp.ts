import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getCostReport, type Guards, type Logger } from "./core.js";
import { DEFAULT_BRAND } from "./index.js";
import { defaultSinks, defaultSources, listSources, runAttribution, selectSinks, selectSources, TwilioSource, type CallSource, type EventSink, type TrackingLine } from "./tracking.js";
export interface McpDeps { sources?: CallSource[]; sinks?: EventSink[]; lineSource?: TwilioSource; guards?: Guards; logger?: Logger }
function reply(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }; }
const lineSchema = z.object({ number: z.string().min(1), campaign: z.string().min(1), source: z.string().min(1), label: z.string().optional() });
export function createMcpServer(deps: McpDeps = {}): McpServer {
  const sources = deps.sources ?? defaultSources();
  const sinks = deps.sinks ?? defaultSinks();
  const lineSource = deps.lineSource ?? new TwilioSource();
  const server = new McpServer({ name: DEFAULT_BRAND.command, version: DEFAULT_BRAND.version });
  server.registerTool("attribute_calls", {
    description: "Pull calls, attribute them to lines, and push them to sinks. Preview by default.",
    inputSchema: {
      to: z.string().optional(), from: z.string().optional(), since: z.string().optional(), limit: z.number().int().positive().optional(),
      file: z.string().optional(), lines: z.array(lineSchema).optional(),
      source: z.string().optional(), sources: z.array(z.string()).min(1).optional(),
      sink: z.string().optional(), sinks: z.array(z.string()).min(1).optional(),
      dryRun: z.boolean().optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ to, from, since, limit, file, lines, source, sources: picked, sink, sinks: pickedSinks, dryRun }) => {
    try {
      const selectedSources = [...new Set(picked ? picked.flatMap(s => selectSources(sources, s)) : selectSources(sources, source))];
      const selectedSinks = [...new Set(pickedSinks ? pickedSinks.flatMap(s => selectSinks(sinks, s)) : selectSinks(sinks, sink))];
      const result = await runAttribution({ query: { to, from, since, limit, file }, lines: (lines ?? []) as TrackingLine[], sources: selectedSources, sinks: selectedSinks }, { ...deps, dryRun: dryRun ?? true });
      return reply(result, !result.dryRun && [...result.sources, ...result.sinks].some(r => !r.ok));
    } catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) }, true); }
  });
  server.registerTool("list_lines", {
    description: "List tracking numbers from Twilio, merged with a line map.",
    inputSchema: { lineMap: z.record(z.string(), z.object({ campaign: z.string(), source: z.string() })).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ lineMap }) => {
    try { return reply(await lineSource.listLines(lineMap ?? {})); }
    catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) }, true); }
  });
  server.registerTool("list_sources", { description: "List sources, sinks, and key status.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => reply(listSources(sources, sinks)));
  server.registerTool("get_cost_report", { description: "Read session cost entries and unit totals.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => reply(getCostReport()));
  return server;
}
export async function startMcp(deps: McpDeps = {}): Promise<void> { await createMcpServer(deps).connect(new StdioServerTransport()); }
