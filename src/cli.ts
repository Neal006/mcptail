#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runProxy } from "./proxy.js";
import { startDashboard } from "./server.js";
import { listSessions, sessionsRoot } from "./store.js";
import { type FileResult, initTaps, removeTaps, tapStatus } from "./taps.js";

const program = new Command();

program
  .name("mcptail")
  .description("See what your AI agent is actually doing — passive traffic capture for MCP.")
  .version(pkg.version);

program
  .command("run")
  .description("Run an MCP server through the tap (what `mcptail init` injects into configs)")
  .option("--label <name>", "display name for the recorded session")
  .argument("<command...>", "the original server command, after --")
  .allowUnknownOption()
  .action(async (command: string[], opts: { label?: string }) => {
    process.exitCode = await runProxy(command, { server: opts.label });
  });

program
  .command("init")
  .description("Wrap every MCP server in your client configs through the tap (backup kept)")
  .action(() => {
    const results = initTaps(process.cwd());
    printResults(results, "wrapped");
    if (results.some((r) => r.changed.length)) {
      console.log("\nRestart your MCP client, use it normally, then: npx mcptail ui");
    } else if (!results.length) {
      console.log("No MCP client configs found here or in your home directory.");
    }
  });

program
  .command("remove")
  .description("Unwrap all servers, restoring your configs")
  .action(() => {
    printResults(removeTaps(process.cwd()), "restored");
  });

program
  .command("doctor")
  .description("Check tap health: configs, wrapped servers, recorded sessions")
  .action(() => {
    const statuses = tapStatus(process.cwd());
    if (!statuses.length) console.log("No MCP client configs found.");
    for (const s of statuses) {
      console.log(`${s.client}  ${s.path}`);
      if (s.tapped.length) console.log(`  tapped:   ${s.tapped.join(", ")}`);
      if (s.untapped.length)
        console.log(`  untapped: ${s.untapped.join(", ")} (run: mcptail init)`);
      if (!s.tapped.length && !s.untapped.length) console.log("  no stdio servers configured");
    }
    const sessions = listSessions();
    console.log(`\nsessions: ${sessions.length} recorded in ${sessionsRoot()}`);
    const latest = sessions[0];
    if (latest) {
      console.log(`  latest: ${latest.server} at ${new Date(latest.startedAt).toISOString()}`);
    } else if (statuses.some((s) => s.tapped.length)) {
      console.log("  taps are active but nothing recorded yet — restart your MCP client.");
    }
  });

program
  .command("ui")
  .description("Open the local dashboard")
  .option("--port <port>", "port to listen on", "4747")
  .action(async (opts: { port: string }) => {
    const url = await startDashboard(Number(opts.port));
    console.log(`mcptail dashboard: ${url}`);
  });

function printResults(results: FileResult[], verb: string): void {
  for (const r of results) {
    if (r.error) {
      console.log(`! ${r.path}: ${r.error}`);
      continue;
    }
    for (const name of r.changed) console.log(`+ ${verb} ${name}  (${r.client}: ${r.path})`);
    for (const name of r.skipped) console.log(`- skipped ${name}  (${r.client})`);
  }
  if (!results.some((r) => r.changed.length || r.skipped.length || r.error)) {
    console.log(`Nothing to ${verb === "wrapped" ? "wrap" : "restore"}.`);
  }
}

program.parseAsync().catch((err) => {
  console.error(`mcptail: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
