const NEWLINE = 0x0a;

/** A parsed JSON-RPC message; kept loose on purpose — we record, never validate. */
export type JsonRpcMessage = { [key: string]: unknown };

export type Frame =
  | { kind: "json"; msg: JsonRpcMessage }
  | { kind: "raw"; raw: string }
  | { kind: "blank" };

/**
 * MCP stdio framing is newline-delimited JSON. Anything that isn't valid JSON
 * is preserved as a raw frame — recording must never assume well-behaved servers.
 */
export function parseFrame(line: string): Frame {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text.trim() === "") return { kind: "blank" };
  try {
    const msg = JSON.parse(text);
    if (typeof msg === "object" && msg !== null && !Array.isArray(msg)) {
      return { kind: "json", msg };
    }
    return { kind: "raw", raw: text };
  } catch {
    return { kind: "raw", raw: text };
  }
}

/**
 * Splits a byte stream into complete lines. Accumulates raw bytes so a
 * multi-byte UTF-8 character split across chunks never corrupts output.
 */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    let idx = this.pending.indexOf(NEWLINE, start);
    while (idx !== -1) {
      lines.push(this.pending.subarray(start, idx).toString("utf8"));
      start = idx + 1;
      idx = this.pending.indexOf(NEWLINE, start);
    }
    this.pending = start ? Buffer.from(this.pending.subarray(start)) : this.pending;
    return lines;
  }

  /** Remaining partial line at end of stream, if any. */
  flush(): string | null {
    if (!this.pending.length) return null;
    const rest = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    return rest;
  }
}
