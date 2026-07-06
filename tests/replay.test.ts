import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardServer } from "../src/server.js";
import { SessionWriter } from "../src/store.js";

const everything = join(
  resolve(__dirname, ".."),
  "node_modules",
  "@modelcontextprotocol",
  "server-everything",
  "dist",
  "index.js",
);

let home: string;
let server: Server;
let base: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mcptail-replay-"));
  process.env.MCPTAIL_HOME = home;
  server = createDashboardServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  delete process.env.MCPTAIL_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/replay", () => {
  it("re-executes a captured tools/call against a fresh server", { timeout: 60000 }, async () => {
    const w = new SessionWriter({
      server: "everything",
      command: [process.execPath, everything],
      startedAt: Date.now(),
      pid: 99,
    });
    w.write({
      ts: 1000,
      dir: "c2s",
      frame: {
        kind: "json",
        msg: {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "echo", arguments: { message: "replayed hello" } },
        },
      },
    });
    w.write({
      ts: 1100,
      dir: "s2c",
      frame: {
        kind: "json",
        msg: { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "original" }] } },
      },
    });

    const res = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: w.file, id: 7, startTs: 1000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      original: unknown;
      replay: { ok: boolean; result?: unknown; error?: string };
    };
    expect(body.replay.ok).toBe(true);
    expect(JSON.stringify(body.replay.result)).toContain("replayed hello");
    expect(JSON.stringify(body.original)).toContain("original");
  });

  it("404s for calls that were never captured", async () => {
    const res = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: join(home, "nope.jsonl"), id: 1, startTs: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
