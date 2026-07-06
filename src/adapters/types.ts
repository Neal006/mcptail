import { homedir } from "node:os";

/** Overridable so tests never touch the real home directory configs. */
export function userHome(): string {
  return process.env.MCPTAIL_USER_HOME ?? homedir();
}

export interface ConfigCandidate {
  /** Absolute path to a config file that may exist. */
  path: string;
  /** Top-level key holding the server map, e.g. "mcpServers" or "servers". */
  serversKey: string;
}

/**
 * One adapter per MCP client. Adding a client = one small file returning
 * where its config lives and which key holds the server map.
 */
export interface ClientAdapter {
  name: string;
  candidates(cwd: string): ConfigCandidate[];
}
