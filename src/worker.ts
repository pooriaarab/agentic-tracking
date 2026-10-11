import { defaultSinks, defaultSources, runAttribution, selectSinks, selectSources, type TrackingLine } from "./tracking.js";
import { VERSION } from "./version.js";
export interface WorkerEnv { PACK_NAME?: string }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function validLines(value: unknown): value is TrackingLine[] {
  return Array.isArray(value) && value.every(l => !!l && typeof l === "object" && typeof (l as Record<string, unknown>).number === "string" && typeof (l as Record<string, unknown>).campaign === "string" && typeof (l as Record<string, unknown>).source === "string");
}
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, pack: env.PACK_NAME ?? "agentic-tracking", version: VERSION });
    if (request.method === "POST" && url.pathname === "/attribute") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); }
      if (!body || typeof body !== "object") return json({ error: "body needs an object" }, 400);
      const b = body as Record<string, unknown>;
      if ((b.to !== undefined && typeof b.to !== "string") || (b.from !== undefined && typeof b.from !== "string") || (b.since !== undefined && typeof b.since !== "string") || (b.file !== undefined && typeof b.file !== "string") || (b.source !== undefined && typeof b.source !== "string") || (b.sink !== undefined && typeof b.sink !== "string") || (b.live !== undefined && typeof b.live !== "boolean") || (b.lines !== undefined && !validLines(b.lines)) || (b.limit !== undefined && (!Number.isSafeInteger(b.limit) || Number(b.limit) < 1))) return json({ error: "invalid attribute body" }, 400);
      try {
        const result = await runAttribution(
          { query: { to: b.to as string | undefined, from: b.from as string | undefined, since: b.since as string | undefined, file: b.file as string | undefined, limit: b.limit as number | undefined }, lines: (b.lines ?? []) as TrackingLine[], sources: selectSources(defaultSources(), b.source as string | undefined), sinks: selectSinks(defaultSinks(), b.sink as string | undefined) },
          { dryRun: b.live !== true },
        );
        return json(result, !result.dryRun && [...result.sources, ...result.sinks].some(r => !r.ok) ? 502 : 200);
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
    }
    return json({ error: "not found" }, 404);
  },
};
