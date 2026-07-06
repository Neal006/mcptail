import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../src/server.js";
import { SessionWriter } from "../src/store.js";

let home: string;
let server: Server;
let base: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "mcptail-srv-"));
  process.env.MCPTAIL_HOME = home;
  server = createDashboardServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MCPTAIL_HOME;
  rmSync(home, { recursive: true, force: true });
});

function seedSession(): string {
  const w = new SessionWriter({
    server: "github",
    command: ["npx", "gh-mcp"],
    startedAt: Date.now(),
    pid: 1,
  });
  w.write({
    ts: 100,
    dir: "c2s",
    frame: { kind: "json", msg: { id: 1, method: "tools/call", params: { name: "create_pr" } } },
  });
  w.write({
    ts: 400,
    dir: "s2c",
    frame: { kind: "json", msg: { id: 1, result: { content: [{ type: "text", text: "ok" }] } } },
  });
  return w.file;
}

describe("dashboard API", () => {
  it("lists sessions", async () => {
    seedSession();
    const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as {
      server: string;
    }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.server).toBe("github");
  });

  it("returns correlated calls, stats, and cost for a session", async () => {
    const file = seedSession();
    const detail = (await (
      await fetch(`${base}/api/session?file=${encodeURIComponent(file)}`)
    ).json()) as {
      calls: { toolName?: string; latencyMs?: number }[];
      stats: { key: string }[];
      totalTokens: number;
      estimatedCostUsd: number;
    };
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0]?.toolName).toBe("create_pr");
    expect(detail.calls[0]?.latencyMs).toBe(300);
    expect(detail.stats[0]?.key).toBe("tools/call:create_pr");
    expect(detail.totalTokens).toBeGreaterThan(0);
    expect(detail.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("rejects session paths outside the sessions root", async () => {
    seedSession();
    const res = await fetch(
      `${base}/api/session?file=${encodeURIComponent("C:\\Windows\\system.ini")}`,
    );
    expect(res.status).toBe(404);
  });

  it("serves a fallback page when the UI is not built", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mcptail");
  });

  it("exposes the pricing model list", async () => {
    const models = (await (await fetch(`${base}/api/models`)).json()) as {
      default: string;
      models: string[];
    };
    expect(models.models).toContain(models.default);
  });

  it("streams a live event when a session file grows", async () => {
    const w = new SessionWriter({ server: "live", command: ["x"], startedAt: Date.now(), pid: 2 });
    const res = await fetch(`${base}/api/live`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");

    setTimeout(() => {
      w.write({ ts: 1, dir: "c2s", frame: { kind: "json", msg: { id: 1, method: "ping" } } });
    }, 100);

    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 5000;
    while (!buffer.includes("data:") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    await reader.cancel();
    expect(buffer).toContain('"server":"live"');
  });
});
