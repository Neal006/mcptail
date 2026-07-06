export interface SessionInfo {
  file: string;
  server: string;
  command: string[];
  startedAt: number;
  pid: number;
}

export interface Call {
  id: string | number;
  method: string;
  toolName?: string;
  request: unknown;
  response?: unknown;
  isError: boolean;
  startTs: number;
  latencyMs?: number;
  requestTokens: number;
  responseTokens: number;
}

export interface ToolStats {
  key: string;
  count: number;
  errors: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  tokens: number;
}

export interface SessionDetail {
  file: string;
  calls: Call[];
  notificationCount: number;
  rawCount: number;
  stats: ToolStats[];
  totalTokens: number;
}

export const fetchSessions = (): Promise<SessionInfo[]> =>
  fetch("/api/sessions").then((r) => r.json());

export const fetchSession = (file: string): Promise<SessionDetail> =>
  fetch(`/api/session?file=${encodeURIComponent(file)}`).then((r) => r.json());

export interface ReplayResponse {
  original: unknown;
  replay: { ok: boolean; result?: unknown; error?: string };
}

export const postReplay = (
  file: string,
  id: string | number,
  startTs: number,
): Promise<ReplayResponse> =>
  fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, id, startTs }),
  }).then((r) => r.json());

export function subscribeLive(onChange: (file: string) => void): () => void {
  const source = new EventSource("/api/live");
  source.onmessage = (event) => {
    try {
      onChange(JSON.parse(event.data).file);
    } catch {
      // malformed keepalive — ignore
    }
  };
  return () => source.close();
}
