const NEWLINE = 0x0a;

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
