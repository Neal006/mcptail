import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregate,
  correlate,
  listSessions,
  mcptapHome,
  readEvents,
  SessionWriter,
  sessionsRoot,
  type TapEvent,
} from "../src/store.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcptap-test-"));
  process.env.MCPTAP_HOME = home;
});

afterEach(() => {
  delete process.env.MCPTAP_HOME;
  rmSync(home, { recursive: true, force: true });
});

const meta = { server: "github", command: ["npx", "gh-mcp"], startedAt: 1751760000000, pid: 42 };
const metaDate = new Date(meta.startedAt).toISOString().slice(0, 10);

describe("SessionWriter", () => {
  it("respects MCPTAP_HOME override", () => {
    expect(mcptapHome()).toBe(home);
    expect(sessionsRoot()).toBe(join(home, "sessions"));
  });

  it("writes a meta line on creation under a date directory", () => {
    const w = new SessionWriter(meta);
    expect(w.file).toContain(metaDate);
    const lines = readFileSync(w.file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({ type: "meta", ...meta });
  });

  it("appends events as JSONL", () => {
    const w = new SessionWriter(meta);
    w.write({ ts: 1, dir: "c2s", frame: { kind: "json", msg: { id: 1, method: "tools/list" } } });
    w.write({ ts: 2, dir: "s2c", frame: { kind: "raw", raw: "junk" } });
    const lines = readFileSync(w.file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1] as string).dir).toBe("c2s");
    expect(JSON.parse(lines[2] as string).frame.raw).toBe("junk");
  });

  it("sanitizes hostile server names so files stay inside the session dir", () => {
    const w = new SessionWriter({ ...meta, server: "../../etc passwd" });
    const files = readdirSync(join(sessionsRoot(), metaDate));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-zA-Z0-9._-]+\.jsonl$/);
    expect(dirname(resolve(w.file))).toBe(resolve(join(sessionsRoot(), metaDate)));
  });

  it("disables itself instead of throwing when the disk path is unwritable", () => {
    process.env.MCPTAP_HOME = join(home, "\0invalid");
    expect(() => {
      const w = new SessionWriter(meta);
      w.write({ ts: 1, dir: "c2s", frame: { kind: "blank" } });
    }).not.toThrow();
  });
});

describe("listSessions / readEvents", () => {
  it("lists sessions newest first and round-trips events", () => {
    const older = new SessionWriter({ ...meta, server: "alpha", startedAt: meta.startedAt });
    const newer = new SessionWriter({ ...meta, server: "beta", startedAt: meta.startedAt + 5000 });
    older.write({ ts: 1, dir: "c2s", frame: { kind: "json", msg: { id: 1, method: "ping" } } });

    const sessions = listSessions();
    expect(sessions.map((s) => s.server)).toEqual(["beta", "alpha"]);
    expect(readEvents(newer.file)).toEqual([]);
    expect(readEvents(older.file)).toHaveLength(1);
  });

  it("skips corrupt lines and returns an empty list when no sessions exist", () => {
    expect(listSessions()).toEqual([]);
    const w = new SessionWriter(meta);
    w.write({ ts: 1, dir: "c2s", frame: { kind: "json", msg: { id: 1, method: "ping" } } });
    appendFileSync(w.file, '{"torn line...\n');
    expect(readEvents(w.file)).toHaveLength(1);
    expect(listSessions()).toHaveLength(1);
  });
});

const rpc = (ts: number, dir: "c2s" | "s2c", msg: object): TapEvent => ({
  ts,
  dir,
  frame: { kind: "json", msg: msg as Record<string, unknown> },
});

describe("correlate", () => {
  it("pairs requests with responses and computes latency", () => {
    const { calls } = correlate([
      rpc(100, "c2s", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scrape" } }),
      rpc(350, "s2c", { jsonrpc: "2.0", id: 1, result: { content: [] } }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("scrape");
    expect(calls[0]?.latencyMs).toBe(250);
    expect(calls[0]?.isError).toBe(false);
    expect(calls[0]?.requestTokens).toBeGreaterThan(0);
  });

  it("flags JSON-RPC errors and MCP isError results", () => {
    const { calls } = correlate([
      rpc(1, "c2s", { id: 1, method: "tools/call", params: { name: "a" } }),
      rpc(2, "s2c", { id: 1, error: { code: -32602, message: "bad params" } }),
      rpc(3, "c2s", { id: 2, method: "tools/call", params: { name: "b" } }),
      rpc(4, "s2c", { id: 2, result: { isError: true, content: [] } }),
    ]);
    expect(calls.map((c) => c.isError)).toEqual([true, true]);
  });

  it("does not cross-match same numeric ids from opposite directions", () => {
    const { calls } = correlate([
      rpc(1, "c2s", { id: 1, method: "tools/list" }),
      rpc(2, "s2c", { id: 1, method: "sampling/createMessage" }),
      rpc(3, "s2c", { id: 1, result: { tools: [] } }),
      rpc(4, "c2s", { id: 1, result: { role: "assistant" } }),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.response)).toBe(true);
    expect(calls[0]?.method).toBe("tools/list");
    expect(calls[1]?.method).toBe("sampling/createMessage");
  });

  it("separates notifications and leaves unanswered requests open", () => {
    const { calls, notifications } = correlate([
      rpc(1, "s2c", { method: "notifications/progress", params: {} }),
      rpc(2, "c2s", { id: 9, method: "tools/list" }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(calls[0]?.response).toBeUndefined();
    expect(calls[0]?.latencyMs).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("groups by tool, counts errors, computes percentiles and tokens", () => {
    const { calls } = correlate([
      rpc(0, "c2s", { id: 1, method: "tools/call", params: { name: "scrape" } }),
      rpc(100, "s2c", { id: 1, result: { ok: 1 } }),
      rpc(200, "c2s", { id: 2, method: "tools/call", params: { name: "scrape" } }),
      rpc(1200, "s2c", { id: 2, error: { code: -1 } }),
      rpc(300, "c2s", { id: 3, method: "tools/list" }),
      rpc(310, "s2c", { id: 3, result: { tools: [] } }),
    ]);
    const stats = aggregate(calls);
    const scrape = stats.find((s) => s.key === "tools/call:scrape");
    expect(scrape).toMatchObject({ count: 2, errors: 1, p50LatencyMs: 100, p95LatencyMs: 1000 });
    expect(stats.find((s) => s.key === "tools/list")?.count).toBe(1);
    expect(scrape?.tokens).toBeGreaterThan(0);
  });

  it("returns empty stats for no calls", () => {
    expect(aggregate([])).toEqual([]);
  });
});
