import { describe, expect, test } from "vitest";
import worker from "./worker.js";

describe("worker", () => {
  test("GET /health reports ok", async () => {
    const response = await worker.fetch(new Request("https://pack.test/health"), {
      PACK_NAME: "probe",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pack: "probe" });
  });

  test("POST /attribute returns preview", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/attribute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "+15551230001", lines: [{ number: "+15551230001", campaign: "summer-sale", source: "website" }] }),
      }),
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dryRun: true, lines: 1 });
  });

  test("POST /attribute rejects a bad body", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/attribute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: 42 }),
      }),
      {},
    );
    expect(response.status).toBe(400);
  });

  test("unknown routes return 404", async () => {
    const response = await worker.fetch(new Request("https://pack.test/nowhere"), {});
    expect(response.status).toBe(404);
  });
});
