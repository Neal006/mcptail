import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { correlate, listSessions, readEvents } from "../src/store.js";

const root = resolve(__dirname, "..");
const cli = join(root, "dist", "cli.js");
const everything = join(
  root,
  "node_modules",
  "@modelcontextprotocol",
  "server-everything",
  "dist",
  "index.js",
);

let home: string;

beforeAll(() => {
  if (!existsSync(cli)) execSync("npm run build", { cwd: root, stdio: "ignore" });
  home = mkdtempSync(join(tmpdir(), "mcptail-e2e-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("e2e: real MCP session through the tap", () => {
  it("proxies a full client session and records every exchange", { timeout: 60000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "run", "--label", "everything", "--", process.execPath, everything],
      env: { ...process.env, MCPTAIL_HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "mcptail-e2e", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    const echo = await client.callTool({ name: "echo", arguments: { message: "tap check" } });
    expect(JSON.stringify(echo.content)).toContain("tap check");

    const bad = await client.callTool({ name: "definitely-not-a-tool", arguments: {} });
    expect(bad.isError).toBe(true);

    await client.close();

    // give the wrapper a beat to flush its final appends after transport close
    await new Promise((r) => setTimeout(r, 500));

    process.env.MCPTAIL_HOME = home;
    try {
      const sessions = listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.server).toBe("everything");

      const { calls } = correlate(readEvents(sessions[0]?.file as string));
      const methods = calls.map((c) => c.method);
      expect(methods).toContain("initialize");
      expect(methods).toContain("tools/list");

      const echoCall = calls.find((c) => c.toolName === "echo");
      expect(echoCall?.isError).toBe(false);
      expect(echoCall?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(echoCall?.response)).toContain("tap check");

      const badCall = calls.find((c) => c.toolName === "definitely-not-a-tool");
      expect(badCall?.isError).toBe(true);
    } finally {
      delete process.env.MCPTAIL_HOME;
    }
  });
});
