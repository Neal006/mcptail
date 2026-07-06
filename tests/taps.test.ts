import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTaps, isWrapped, removeTaps, tapStatus, unwrapEntry, wrapEntry } from "../src/taps.js";

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mcptap-cwd-"));
  home = mkdtempSync(join(tmpdir(), "mcptap-userhome-"));
  process.env.MCPTAP_USER_HOME = home;
});

afterEach(() => {
  delete process.env.MCPTAP_USER_HOME;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const firecrawl = { command: "npx", args: ["-y", "firecrawl-mcp"], env: { KEY: "x" } };

function writeConfig(path: string, serversKey: string, servers: object): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ [serversKey]: servers }, null, 2));
}

describe("wrapEntry / unwrapEntry", () => {
  it("round-trips an entry byte-identically", () => {
    const entry = structuredClone(firecrawl);
    expect(wrapEntry("firecrawl", entry)).toBe(true);
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual([
      "-y",
      "mcptap",
      "run",
      "--label",
      "firecrawl",
      "--",
      "npx",
      "-y",
      "firecrawl-mcp",
    ]);
    expect(entry.env).toEqual({ KEY: "x" });
    expect(unwrapEntry(entry)).toBe(true);
    expect(entry).toEqual(firecrawl);
  });

  it("round-trips an entry that had no args", () => {
    const entry: { command?: string; args?: string[] } = { command: "my-server" };
    wrapEntry("plain", entry);
    expect(unwrapEntry(entry)).toBe(true);
    expect(entry).toEqual({ command: "my-server" });
  });

  it("is idempotent — wrapping twice is a no-op", () => {
    const entry = structuredClone(firecrawl);
    wrapEntry("firecrawl", entry);
    const once = structuredClone(entry);
    expect(wrapEntry("firecrawl", entry)).toBe(false);
    expect(entry).toEqual(once);
    expect(isWrapped(entry)).toBe(true);
  });
});

describe("initTaps / removeTaps", () => {
  it("wraps servers across client configs and writes a backup", () => {
    writeConfig(join(cwd, ".mcp.json"), "mcpServers", { firecrawl });
    writeConfig(join(home, ".cursor", "mcp.json"), "mcpServers", { github: firecrawl });
    writeConfig(join(cwd, ".vscode", "mcp.json"), "servers", { db: firecrawl });

    const results = initTaps(cwd);
    expect(results.flatMap((r) => r.changed).sort()).toEqual(["db", "firecrawl", "github"]);

    const written = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(written.mcpServers.firecrawl.args).toContain("mcptap");
    expect(readdirSync(cwd).some((f) => f.startsWith(".mcp.json.mcptap-backup-"))).toBe(true);
  });

  it("remove restores the original config content", () => {
    const original = { mcpServers: { firecrawl } };
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(original, null, 2));
    initTaps(cwd);
    removeTaps(cwd);
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"))).toEqual(original);
  });

  it("skips url-based servers and reports them", () => {
    writeConfig(join(cwd, ".mcp.json"), "mcpServers", {
      remote: { url: "https://mcp.example.com/sse" },
      local: firecrawl,
    });
    const [result] = initTaps(cwd);
    expect(result?.changed).toEqual(["local"]);
    expect(result?.skipped[0]).toContain("remote");
  });

  it("reports unparseable configs instead of clobbering them", () => {
    writeFileSync(join(cwd, ".mcp.json"), "// jsonc comment\n{}");
    const [result] = initTaps(cwd);
    expect(result?.error).toBeDefined();
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain("// jsonc comment");
  });

  it("returns no results when no configs exist", () => {
    expect(initTaps(cwd)).toEqual([]);
  });
});

describe("tapStatus", () => {
  it("reports tapped and untapped servers per config", () => {
    writeConfig(join(cwd, ".mcp.json"), "mcpServers", {
      a: structuredClone(firecrawl),
      b: structuredClone(firecrawl),
    });
    initTaps(cwd);
    writeConfig(join(home, ".cursor", "mcp.json"), "mcpServers", { c: firecrawl });

    const statuses = tapStatus(cwd);
    const project = statuses.find((s) => s.path.endsWith(".mcp.json"));
    const cursorGlobal = statuses.find((s) => s.client === "cursor");
    expect(project?.tapped.sort()).toEqual(["a", "b"]);
    expect(cursorGlobal?.untapped).toEqual(["c"]);
  });
});
