import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { adapters } from "./adapters/index.js";

interface ServerEntry {
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

const WRAP_PREFIX = ["-y", "mcptail", "run", "--label"];

export function isWrapped(entry: ServerEntry): boolean {
  return (
    entry.command === "npx" &&
    Array.isArray(entry.args) &&
    entry.args[1] === "mcptail" &&
    entry.args[2] === "run"
  );
}

export function wrapEntry(name: string, entry: ServerEntry): boolean {
  if (typeof entry.command !== "string" || isWrapped(entry)) return false;
  entry.args = [...WRAP_PREFIX, name, "--", entry.command, ...(entry.args ?? [])];
  entry.command = "npx";
  return true;
}

export function unwrapEntry(entry: ServerEntry): boolean {
  if (!isWrapped(entry) || !Array.isArray(entry.args)) return false;
  const sep = entry.args.indexOf("--");
  const original = entry.args.slice(sep + 1);
  if (sep === -1 || !original.length) return false;
  entry.command = original[0] as string;
  const rest = original.slice(1);
  if (rest.length) entry.args = rest;
  else delete entry.args;
  return true;
}

export interface FileResult {
  client: string;
  path: string;
  changed: string[];
  skipped: string[];
  error?: string;
}

function applyToFile(
  client: string,
  path: string,
  serversKey: string,
  transform: (name: string, entry: ServerEntry) => boolean,
  backup: boolean,
): FileResult | null {
  if (!existsSync(path)) return null;
  const result: FileResult = { client, path, changed: [], skipped: [] };
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    result.error = "not parseable as JSON (JSONC with comments is not supported yet)";
    return result;
  }
  const servers = config[serversKey];
  if (!servers || typeof servers !== "object") return result;

  for (const [name, entry] of Object.entries(servers as Record<string, ServerEntry>)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command !== "string") {
      result.skipped.push(`${name} (no command — http/sse servers not supported yet)`);
      continue;
    }
    if (transform(name, entry)) result.changed.push(name);
  }

  if (result.changed.length) {
    if (backup) copyFileSync(path, `${path}.mcptail-backup-${Date.now()}`);
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return result;
}

export function initTaps(cwd: string): FileResult[] {
  return forEachCandidate(cwd, (client, path, key) =>
    applyToFile(client, path, key, wrapEntry, true),
  );
}

export function removeTaps(cwd: string): FileResult[] {
  return forEachCandidate(cwd, (client, path, key) =>
    applyToFile(client, path, key, (_name, entry) => unwrapEntry(entry), false),
  );
}

export interface TapStatus {
  client: string;
  path: string;
  tapped: string[];
  untapped: string[];
}

export function tapStatus(cwd: string): TapStatus[] {
  const statuses: TapStatus[] = [];
  for (const adapter of adapters) {
    for (const { path, serversKey } of adapter.candidates(cwd)) {
      if (!existsSync(path)) continue;
      try {
        const config = JSON.parse(readFileSync(path, "utf8"));
        const servers = config[serversKey];
        if (!servers || typeof servers !== "object") continue;
        const status: TapStatus = { client: adapter.name, path, tapped: [], untapped: [] };
        for (const [name, entry] of Object.entries(servers as Record<string, ServerEntry>)) {
          if (typeof entry?.command !== "string") continue;
          (isWrapped(entry) ? status.tapped : status.untapped).push(name);
        }
        statuses.push(status);
      } catch {
        statuses.push({ client: adapter.name, path, tapped: [], untapped: [] });
      }
    }
  }
  return statuses;
}

function forEachCandidate(
  cwd: string,
  fn: (client: string, path: string, serversKey: string) => FileResult | null,
): FileResult[] {
  const results: FileResult[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    for (const { path, serversKey } of adapter.candidates(cwd)) {
      if (seen.has(path)) continue;
      seen.add(path);
      const result = fn(adapter.name, path, serversKey);
      if (result) results.push(result);
    }
  }
  return results;
}
