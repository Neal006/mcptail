import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProxy } from "../src/proxy.js";
import { sessionsRoot } from "../src/store.js";

const ECHO_SERVER = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
  }
});
`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcptail-proxy-"));
  process.env.MCPTAIL_HOME = home;
});

afterEach(() => {
  delete process.env.MCPTAIL_HOME;
  rmSync(home, { recursive: true, force: true });
});

function readLines(stream: PassThrough, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n").filter(Boolean);
      if (lines.length >= count) resolve(lines.slice(0, count));
    });
  });
}

function sessionFile(): string {
  const root = sessionsRoot();
  const day = readdirSync(root)[0] as string;
  const file = readdirSync(join(root, day))[0] as string;
  return join(root, day, file);
}

function sessionEvents(): { type?: string; dir?: string; frame?: { kind: string } }[] {
  return readFileSync(sessionFile(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("runProxy", () => {
  it("forwards requests to the child and responses back", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const exit = runProxy(["node", "-e", ECHO_SERVER], { server: "echo", input, output });
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    const [line] = await readLines(output, 1);
    expect(JSON.parse(line as string)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    input.end();
    expect(await exit).toBe(0);
  });

  it("records both directions to the session log", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const exit = runProxy(["node", "-e", ECHO_SERVER], { server: "echo", input, output });
    input.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
    await readLines(output, 1);
    input.end();
    await exit;
    const events = sessionEvents();
    expect(events[0]?.type).toBe("meta");
    const dirs = events.slice(1).map((e) => e.dir);
    expect(dirs).toContain("c2s");
    expect(dirs).toContain("s2c");
  });

  it("forwards and records non-JSON child output as raw frames", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const exit = runProxy(
      ["node", "-e", 'process.stdout.write("plain log line\\n"); process.exit(0);'],
      { server: "noisy", input, output },
    );
    const [line] = await readLines(output, 1);
    expect(line).toBe("plain log line");
    expect(await exit).toBe(0);
    const raw = sessionEvents().find((e) => e.frame?.kind === "raw");
    expect(raw).toBeDefined();
  });

  it("propagates the child exit code", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(await runProxy(["node", "-e", "process.exit(3)"], { input, output })).toBe(3);
  });

  it("returns 127 when the command cannot be spawned", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(await runProxy(["definitely-not-a-real-binary-xyz"], { input, output })).toBe(127);
  });

  it("keeps traffic flowing when recording is disabled", async () => {
    process.env.MCPTAIL_HOME = join(home, "\0invalid");
    const input = new PassThrough();
    const output = new PassThrough();
    const exit = runProxy(["node", "-e", ECHO_SERVER], { server: "echo", input, output });
    input.write('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
    const [line] = await readLines(output, 1);
    expect(JSON.parse(line as string).id).toBe(9);
    input.end();
    expect(await exit).toBe(0);
  });
});
