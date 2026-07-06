import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

export interface ReplayResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Re-fires one captured request against a freshly spawned server instance.
 * The spawn uses the session's recorded original command — never the tap,
 * so replays are not re-recorded.
 */
export async function replayCall(
  command: string[],
  method: string,
  params: unknown,
): Promise<ReplayResult> {
  const [cmd, ...args] = command;
  if (!cmd) return { ok: false, error: "session has no server command recorded" };
  if (method === "initialize") {
    return { ok: false, error: "initialize runs implicitly on every replay" };
  }
  const transport = new StdioClientTransport({ command: cmd, args });
  const client = new Client({ name: "mcptail-replay", version: "0.0.0" });
  try {
    await client.connect(transport);
    const request = { method, params } as Parameters<Client["request"]>[0];
    const result = await client.request(request, z.record(z.unknown()), { timeout: 30_000 });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.close().catch(() => {});
  }
}
