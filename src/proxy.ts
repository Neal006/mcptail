import type { Readable, Writable } from "node:stream";
import spawn from "cross-spawn";
import { LineSplitter, parseFrame } from "./frames.js";
import { SessionWriter } from "./store.js";

export interface ProxyOptions {
  /** Display name for the session file; defaults to the command basename. */
  server?: string;
  /** Injectable for tests; defaults to process stdin/stdout. */
  input?: Readable;
  output?: Writable;
}

/**
 * Transparent stdio tee: client <-> child traffic is forwarded byte-for-byte
 * and recorded on the side. Forwarding always happens first; any failure in
 * the tap degrades this to a plain pipe rather than breaking the session.
 */
export function runProxy(command: string[], opts: ProxyOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command;
    if (!cmd) {
      process.stderr.write("[mcptail] usage: mcptail run -- <command> [args...]\n");
      resolve(2);
      return;
    }
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;

    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", (err) => {
      process.stderr.write(`[mcptail] failed to start ${cmd}: ${String(err)}\n`);
      resolve(127);
    });

    const writer = new SessionWriter({
      server: opts.server ?? cmd,
      command,
      startedAt: Date.now(),
      pid: child.pid ?? -1,
    });

    let tapBroken = false;
    const tee = (splitter: LineSplitter, dir: "c2s" | "s2c", chunk: Buffer): void => {
      if (tapBroken) return;
      try {
        for (const line of splitter.push(chunk)) {
          const frame = parseFrame(line);
          if (frame.kind === "blank") continue;
          writer.write({ ts: Date.now(), dir, frame });
        }
      } catch (err) {
        tapBroken = true;
        process.stderr.write(`[mcptail] tap disabled, continuing as plain pipe: ${String(err)}\n`);
      }
    };

    const c2s = new LineSplitter();
    const s2c = new LineSplitter();

    // ponytail: no backpressure handling — MCP traffic is line-sized JSON, not bulk
    // transfer; wire up pipe()-style flow control if a real server ever floods this
    input.on("data", (chunk: Buffer) => {
      child.stdin?.write(chunk);
      tee(c2s, "c2s", chunk);
    });
    input.on("end", () => child.stdin?.end());
    input.on("error", () => child.stdin?.end());
    child.stdin?.on("error", () => {}); // EPIPE when the child dies mid-write

    child.stdout?.on("data", (chunk: Buffer) => {
      output.write(chunk);
      tee(s2c, "s2c", chunk);
    });
    output.on("error", () => {}); // EPIPE when the client goes away

    child.on("close", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => child.kill(sig));
    }
  });
}
