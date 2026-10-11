#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getCostReport, GuardError, VendorError } from "./core.js";
import { defaultSinks, defaultSources, listSources, readDoctor, readLinesFile, runAttribution, selectSinks, selectSources, TwilioSource, type CallQuery, type CallSource, type EventSink, type TrackingLine } from "./tracking.js";
import { DEFAULT_BRAND } from "./index.js";
import { VERSION } from "./version.js";
export class UsageError extends Error { constructor(message: string) { super(message); this.name = "UsageError"; } }
export type CliCommand = "attribute" | "lines" | "sources" | "costs" | "doctor" | "mcp" | "help" | "version";
export interface CliRequest extends CallQuery { command: CliCommand; dryRun: boolean; source: string; sink: string; lines?: string }
export function parseArgs(argv: string[]): CliRequest {
  const args = [...argv]; const first = args.shift() ?? "help";
  const command = first === "--help" || first === "-h" ? "help" : first === "--version" || first === "-V" ? "version" : first;
  if (!["attribute", "lines", "sources", "costs", "doctor", "mcp", "help", "version"].includes(command)) throw new UsageError(`unknown command "${first}"`);
  const request: CliRequest = { command: command as CliCommand, dryRun: true, source: "all", sink: "all" };
  const withValue = command === "attribute"
    ? ["--to", "--from", "--since", "--limit", "--file", "--lines", "--source", "--sink"]
    : command === "lines" ? ["--lines"] : [];
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--live" && command === "attribute") { request.dryRun = false; continue; }
    if (!withValue.includes(flag)) throw new UsageError(`unknown flag "${flag}"`);
    const value = args.shift(); if (!value || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--limit") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new UsageError("--limit needs a positive integer");
      request.limit = Number(value);
    } else if (flag === "--to") request.to = value;
    else if (flag === "--from") request.from = value;
    else if (flag === "--since") request.since = value;
    else if (flag === "--file") request.file = value;
    else if (flag === "--lines") request.lines = value;
    else if (flag === "--source") request.source = value;
    else request.sink = value;
  }
  if (request.since !== undefined && Number.isNaN(Date.parse(request.since))) throw new UsageError("--since needs a date");
  if (request.source !== "all" && !defaultSources().some(a => a.name === request.source)) throw new UsageError(`unknown source: ${request.source}`);
  if (request.sink !== "all" && !defaultSinks().some(a => a.name === request.sink)) throw new UsageError(`unknown sink: ${request.sink}`);
  return request;
}
export interface CliIo { out(line: string): void; err(line: string): void; sources?: CallSource[]; sinks?: EventSink[]; lineSource?: TwilioSource; fetchFn?: typeof fetch }
function helpText(): string {
  return `${DEFAULT_BRAND.name} ${VERSION}
${DEFAULT_BRAND.description}

Usage: agentic-tracking <command> [flags]

Commands:
  attribute [--to <n>] [--from <n>] [--since <d>]
            [--limit <n>] [--file <p>] [--lines <p>]
            [--source <name|all>] [--sink <name|all>] [--live]
  lines [--lines <p>]   List tracking numbers from Twilio.
  sources   List sources, sinks, and key status.
  costs     Print session cost totals.
  doctor    Check vendor reach and key status.
  mcp       Start the MCP server on stdio.
  help      Print this help.
  version   Print the version.

Attribute defaults to a dry run with no vendor calls.
Flags: --help, -h; --version, -V`;
}
async function linesFor(request: CliRequest): Promise<TrackingLine[]> {
  return request.lines ? readLinesFile(request.lines) : [];
}
export async function runCli(argv: string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  let request: CliRequest;
  try { request = parseArgs(argv); } catch (error) { io.err(error instanceof Error ? error.message : String(error)); io.err('Run "agentic-tracking --help" for usage.'); return 2; }
  try {
    const sources = io.sources ?? defaultSources();
    const sinks = io.sinks ?? defaultSinks();
    switch (request.command) {
      case "help": io.out(helpText()); return 0;
      case "version": io.out(VERSION); return 0;
      case "sources": io.out(JSON.stringify(listSources(sources, sinks))); return 0;
      case "costs": io.out(JSON.stringify(getCostReport())); return 0;
      case "doctor": io.out(JSON.stringify(await readDoctor({ fetchFn: io.fetchFn }))); return 0;
      case "mcp": { const { startMcp } = await import("./mcp.js"); await startMcp({ sources, sinks }); return 0; }
      case "lines": {
        const lineSource = io.lineSource ?? new TwilioSource(io.fetchFn ? { fetchFn: io.fetchFn } : {});
        const map: Record<string, { campaign: string; source: string }> = {};
        for (const line of await linesFor(request)) map[line.number] = { campaign: line.campaign, source: line.source };
        io.out(JSON.stringify(await lineSource.listLines(map))); return 0;
      }
      case "attribute": {
        const { to, from, since, limit, file } = request;
        const result = await runAttribution(
          { query: { to, from, since, limit, file }, lines: await linesFor(request), sources: selectSources(sources, request.source), sinks: selectSinks(sinks, request.sink) },
          { dryRun: request.dryRun },
        );
        io.out(JSON.stringify(result));
        return !result.dryRun && [...result.sources, ...result.sinks].some(r => !r.ok) ? 1 : 0;
      }
    }
  } catch (error) {
    if (error instanceof GuardError || error instanceof VendorError || error instanceof UsageError) { io.err(`${error.name}: ${error.message}`); return 1; }
    throw error;
  }
}
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
