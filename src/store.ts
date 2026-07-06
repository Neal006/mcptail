import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "./cost.js";
import type { Frame, JsonRpcMessage } from "./frames.js";

export interface SessionMeta {
  type: "meta";
  server: string;
  command: string[];
  startedAt: number;
  pid: number;
}

export interface TapEvent {
  ts: number;
  dir: "c2s" | "s2c";
  frame: Frame;
}

export function mcptailHome(): string {
  return process.env.MCPTAIL_HOME ?? join(homedir(), ".mcptail");
}

export function sessionsRoot(): string {
  return join(mcptailHome(), "sessions");
}

function dateDir(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Append-only JSONL session log. Every write is wrapped: a failing disk must
 * never take down the proxied session, so the writer disables itself on the
 * first error and warns once on stderr.
 */
export class SessionWriter {
  readonly file: string;
  private broken = false;

  constructor(meta: Omit<SessionMeta, "type">) {
    const dir = join(sessionsRoot(), dateDir(meta.startedAt));
    const name = `${sanitize(meta.server)}-${meta.startedAt}-${meta.pid}.jsonl`;
    this.file = join(dir, name);
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(this.file, `${JSON.stringify({ type: "meta", ...meta })}\n`);
    } catch (err) {
      this.disable(err);
    }
  }

  write(event: TapEvent): void {
    if (this.broken) return;
    try {
      // ponytail: sync append after traffic is already forwarded (~µs per line,
      // crash-safe); switch to batched async writes if a chatty server measures slow
      appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    } catch (err) {
      this.disable(err);
    }
  }

  private disable(err: unknown): void {
    if (this.broken) return;
    this.broken = true;
    process.stderr.write(`[mcptail] recording disabled: ${String(err)}\n`);
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "server";
}

export interface SessionInfo extends Omit<SessionMeta, "type"> {
  file: string;
}

/** Newest first. Sessions with a missing or corrupt meta line are skipped. */
export function listSessions(): SessionInfo[] {
  const root = sessionsRoot();
  const sessions: SessionInfo[] = [];
  for (const day of safeReaddir(root)) {
    for (const name of safeReaddir(join(root, day))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(root, day, name);
      const meta = readMeta(file);
      if (meta) sessions.push({ ...meta, file });
    }
  }
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readMeta(file: string): Omit<SessionMeta, "type"> | null {
  try {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "meta") return null;
    const { type: _type, ...meta } = parsed;
    return meta;
  } catch {
    return null;
  }
}

export function readEvents(file: string): TapEvent[] {
  const events: TapEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.dir && parsed?.frame) events.push(parsed);
    } catch {
      // a torn tail line (proxy killed mid-append) is expected; skip it
    }
  }
  return events;
}

export interface Call {
  id: string | number;
  method: string;
  toolName?: string;
  request: JsonRpcMessage;
  response?: JsonRpcMessage;
  isError: boolean;
  startTs: number;
  endTs?: number;
  latencyMs?: number;
  requestTokens: number;
  responseTokens: number;
}

export interface Correlated {
  calls: Call[];
  notifications: TapEvent[];
  raw: TapEvent[];
}

/** Pairs JSON-RPC requests with responses by id; direction-aware so server-initiated requests correlate too. */
export function correlate(events: TapEvent[]): Correlated {
  const calls: Call[] = [];
  const notifications: TapEvent[] = [];
  const raw: TapEvent[] = [];
  const pending = new Map<string, Call>();

  for (const event of events) {
    if (event.frame.kind === "raw") {
      raw.push(event);
      continue;
    }
    if (event.frame.kind !== "json") continue;
    const msg = event.frame.msg;
    const hasId = msg.id !== undefined && msg.id !== null;

    if (typeof msg.method === "string" && hasId) {
      const call: Call = {
        id: msg.id as string | number,
        method: msg.method,
        toolName: toolNameOf(msg),
        request: msg,
        isError: false,
        startTs: event.ts,
        requestTokens: estimateTokens(msg),
        responseTokens: 0,
      };
      pending.set(`${event.dir}:${String(msg.id)}`, call);
      calls.push(call);
    } else if (hasId && ("result" in msg || "error" in msg)) {
      const reqDir = event.dir === "s2c" ? "c2s" : "s2c";
      const call = pending.get(`${reqDir}:${String(msg.id)}`);
      if (!call) continue;
      pending.delete(`${reqDir}:${String(msg.id)}`);
      call.response = msg;
      call.endTs = event.ts;
      call.latencyMs = event.ts - call.startTs;
      call.responseTokens = estimateTokens(msg);
      call.isError =
        "error" in msg || (msg.result as { isError?: boolean } | undefined)?.isError === true;
    } else if (typeof msg.method === "string") {
      notifications.push(event);
    }
  }
  return { calls, notifications, raw };
}

function toolNameOf(msg: JsonRpcMessage): string | undefined {
  if (msg.method !== "tools/call") return undefined;
  const name = (msg.params as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : undefined;
}

export interface ToolStats {
  key: string;
  count: number;
  errors: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  tokens: number;
}

export function aggregate(calls: Call[]): ToolStats[] {
  const groups = new Map<string, Call[]>();
  for (const call of calls) {
    const key = call.toolName ? `tools/call:${call.toolName}` : call.method;
    const group = groups.get(key);
    if (group) group.push(call);
    else groups.set(key, [call]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const latencies = group
        .map((c) => c.latencyMs)
        .filter((l): l is number => l !== undefined)
        .sort((a, b) => a - b);
      return {
        key,
        count: group.length,
        errors: group.filter((c) => c.isError).length,
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        tokens: group.reduce((sum, c) => sum + c.requestTokens + c.responseTokens, 0),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}
