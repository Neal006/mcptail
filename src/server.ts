import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, estimateCostUsd, knownModels } from "./cost.js";
import { replayCall } from "./replay.js";
import { aggregate, correlate, listSessions, readEvents, sessionsRoot } from "./store.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

function uiDir(): string {
  return fileURLToPath(new URL("./ui/", import.meta.url));
}

/** Reject any session path that escapes the sessions root — the API takes file paths from the browser. */
function safeSessionFile(raw: string | null): string | null {
  if (!raw) return null;
  const resolved = resolve(raw);
  const root = resolve(sessionsRoot());
  if (!resolved.startsWith(`${root}\\`) && !resolved.startsWith(`${root}/`)) return null;
  return existsSync(resolved) ? resolved : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sessionDetail(file: string, model: string) {
  const events = readEvents(file);
  const { calls, notifications, raw } = correlate(events);
  const stats = aggregate(calls);
  const totalTokens = stats.reduce((sum, s) => sum + s.tokens, 0);
  return {
    file,
    calls,
    notificationCount: notifications.length,
    rawCount: raw.length,
    stats,
    totalTokens,
    estimatedCostUsd: estimateCostUsd(totalTokens, model),
    model,
  };
}

export function createDashboardServer() {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/sessions") {
      return json(res, 200, listSessions());
    }

    if (url.pathname === "/api/session") {
      const file = safeSessionFile(url.searchParams.get("file"));
      if (!file) return json(res, 404, { error: "unknown session" });
      const model = url.searchParams.get("model") ?? DEFAULT_MODEL;
      return json(res, 200, sessionDetail(file, model));
    }

    if (url.pathname === "/api/models") {
      return json(res, 200, { default: DEFAULT_MODEL, models: knownModels() });
    }

    if (url.pathname === "/api/replay" && req.method === "POST") {
      readBody(req)
        .then(async (body) => {
          const {
            file: rawFile,
            id,
            startTs,
          } = body as {
            file?: string;
            id?: string | number;
            startTs?: number;
          };
          const file = safeSessionFile(rawFile ?? null);
          if (!file) return json(res, 404, { error: "unknown session" });
          const session = listSessions().find((s) => s.file === file);
          const call = correlate(readEvents(file)).calls.find(
            (c) => String(c.id) === String(id) && c.startTs === startTs,
          );
          if (!session || !call) return json(res, 404, { error: "unknown call" });
          const outcome = await replayCall(
            session.command,
            call.method,
            (call.request as { params?: unknown }).params,
          );
          json(res, 200, { original: call.response ?? null, replay: outcome });
        })
        .catch(() => json(res, 400, { error: "invalid request body" }));
      return;
    }

    if (url.pathname === "/api/live") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      // ponytail: 500ms size polling instead of fs.watch — identical behavior on
      // win/mac/linux; switch to watchers if anyone measures the poll as a problem
      const offsets = new Map<string, number>();
      for (const s of listSessions()) offsets.set(s.file, fileSize(s.file));
      const timer = setInterval(() => {
        for (const s of listSessions()) {
          const size = fileSize(s.file);
          const seen = offsets.get(s.file);
          if (seen === undefined || size > seen) {
            offsets.set(s.file, size);
            res.write(`data: ${JSON.stringify({ file: s.file, server: s.server })}\n\n`);
          }
        }
      }, 500);
      req.on("close", () => clearInterval(timer));
      return;
    }

    serveStatic(url.pathname, res);
  });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const dir = uiDir();
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(join(dir, rel));
  if (file.startsWith(resolve(dir)) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
    return;
  }
  const index = join(dir, "index.html");
  if (existsSync(index)) {
    res.writeHead(200, { "content-type": MIME[".html"] as string });
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(200, { "content-type": MIME[".html"] as string });
  res.end("<h1>mcptail</h1><p>Dashboard UI not built. API is live at /api/sessions.</p>");
}

export function startDashboard(port: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const server = createDashboardServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolvePromise(`http://localhost:${port}`);
    });
  });
}
