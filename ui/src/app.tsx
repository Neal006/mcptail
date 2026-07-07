import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type Call,
  fetchSession,
  fetchSessions,
  postReplay,
  type ReplayResponse,
  type SessionDetail,
  type SessionInfo,
  subscribeLive,
} from "./api.js";
import { callLabel, filterTimelineCalls } from "./timeline-filter.js";

const time = (ts: number) => new Date(ts).toLocaleTimeString();
const day = (ts: number) => new Date(ts).toLocaleDateString();

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [timelineQuery, setTimelineQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);

  useEffect(() => {
    fetchSessions().then((list) => {
      setSessions(list);
      if (list[0]) setSelected((cur) => cur ?? list[0].file);
    });
  }, []);

  useEffect(() => {
    return subscribeLive((changedFile) => {
      fetchSessions().then(setSessions);
      setSelected((cur) => {
        if (cur === changedFile) fetchSession(changedFile).then(setDetail);
        return cur ?? changedFile;
      });
    });
  }, []);

  useEffect(() => {
    if (selected) fetchSession(selected).then(setDetail);
    else setDetail(null);
  }, [selected]);

  const errorCount = useMemo(() => detail?.calls.filter((c) => c.isError).length ?? 0, [detail]);
  const filteredCalls = useMemo(
    () => (detail ? filterTimelineCalls(detail.calls, timelineQuery, errorsOnly) : []),
    [detail, errorsOnly, timelineQuery],
  );

  return (
    <div class="layout">
      <header>
        <span class="logo">mcptail</span>
        <span class="live-dot" title="live" />
      </header>

      <aside>
        <h2>Sessions</h2>
        {sessions.map((s) => (
          <button
            type="button"
            key={s.file}
            class={`session ${s.file === selected ? "active" : ""}`}
            onClick={() => {
              setSelected(s.file);
              setCall(null);
            }}
          >
            <div class="name">{s.server}</div>
            <div class="when">
              {day(s.startedAt)} {time(s.startedAt)}
            </div>
          </button>
        ))}
        {!sessions.length && (
          <div class="empty">
            No sessions yet.
            <br />
            Run <code>npx mcptail init</code>, then use your MCP client.
          </div>
        )}
      </aside>

      <main>
        {detail ? (
          <>
            <div class="tiles">
              <Tile value={String(detail.calls.length)} label="calls" />
              <Tile value={String(errorCount)} label="errors" err={errorCount > 0} />
              <Tile value={detail.totalTokens.toLocaleString()} label="est. tokens" />
              <Tile value={String(detail.notificationCount)} label="notifications" />
            </div>

            <h2>Per tool</h2>
            <table>
              <thead>
                <tr>
                  <th>tool / method</th>
                  <th style="text-align:right">calls</th>
                  <th style="text-align:right">errors</th>
                  <th style="text-align:right">p50</th>
                  <th style="text-align:right">p95</th>
                  <th style="text-align:right">tokens</th>
                </tr>
              </thead>
              <tbody>
                {detail.stats.map((s) => (
                  <tr key={s.key}>
                    <td>{s.key}</td>
                    <td class="num">{s.count}</td>
                    <td class="num">{s.errors || ""}</td>
                    <td class="num">{s.p50LatencyMs}ms</td>
                    <td class="num">{s.p95LatencyMs}ms</td>
                    <td class="num">{s.tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div class="section-gap" />
            <h2>Timeline</h2>
            <div class="timeline-controls">
              <input
                aria-label="Filter timeline calls"
                type="search"
                placeholder="filter by tool or method"
                value={timelineQuery}
                onInput={(event) => setTimelineQuery(event.currentTarget.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(event) => setErrorsOnly(event.currentTarget.checked)}
                />
                errors only
              </label>
            </div>
            <table>
              <thead>
                <tr>
                  <th>call</th>
                  <th>time</th>
                  <th style="text-align:right">latency</th>
                  <th style="text-align:right">tokens</th>
                </tr>
              </thead>
              <tbody>
                {filteredCalls.map((c) => (
                  <tr
                    key={`${c.startTs}-${String(c.id)}`}
                    class={`call ${call === c ? "selected" : ""}`}
                    onClick={() => setCall(c)}
                  >
                    <td>
                      <span class={`status ${c.isError ? "err" : c.response ? "" : "pending"}`} />
                      {callLabel(c)}
                    </td>
                    <td class="num">{time(c.startTs)}</td>
                    <td class="num">{c.latencyMs === undefined ? "…" : `${c.latencyMs}ms`}</td>
                    <td class="num">{(c.requestTokens + c.responseTokens).toLocaleString()}</td>
                  </tr>
                ))}
                {!filteredCalls.length && (
                  <tr>
                    <td class="empty-row" colSpan={4}>
                      {detail.calls.length ? "no matching calls" : "no calls yet"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        ) : (
          <div class="empty">Select a session.</div>
        )}
      </main>

      {call && detail && (
        <CallDetail call={call} file={detail.file} onClose={() => setCall(null)} />
      )}
    </div>
  );
}

function Tile({ value, label, err }: { value: string; label: string; err?: boolean }) {
  return (
    <div class="tile">
      <div class={`value ${err ? "err" : ""}`}>{value}</div>
      <div class="label">{label}</div>
    </div>
  );
}

function CallDetail({ call, file, onClose }: { call: Call; file: string; onClose: () => void }) {
  const [replay, setReplay] = useState<ReplayResponse["replay"] | "running" | null>(null);

  const runReplay = () => {
    if (!confirm("Replay re-executes this call against a fresh server instance. Continue?")) {
      return;
    }
    setReplay("running");
    postReplay(file, call.id, call.startTs)
      .then((r) => setReplay(r.replay))
      .catch((err) => setReplay({ ok: false, error: String(err) }));
  };

  return (
    <div class="detail">
      <button type="button" class="close" onClick={onClose}>
        ×
      </button>
      <h3>{callLabel(call)}</h3>
      <div class="meta">
        {call.isError ? "❌ error" : call.response ? "✓ ok" : "⏳ no response captured"}
        {call.latencyMs !== undefined && ` · ${call.latencyMs}ms`}
        {` · ${(call.requestTokens + call.responseTokens).toLocaleString()} est. tokens`}
        {" · "}
        <button type="button" class="copy" onClick={runReplay} disabled={replay === "running"}>
          {replay === "running" ? "replaying…" : "▶ replay"}
        </button>
      </div>
      <JsonBlock title="Request" value={call.request} />
      {call.response !== undefined && <JsonBlock title="Response" value={call.response} />}
      {replay && replay !== "running" && (
        <JsonBlock
          title={replay.ok ? "Replay result" : "Replay failed"}
          value={replay.ok ? replay.result : replay.error}
        />
      )}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <>
      <h4>
        {title}
        <button type="button" class="copy" onClick={() => navigator.clipboard.writeText(text)}>
          copy
        </button>
      </h4>
      <pre>{text}</pre>
    </>
  );
}
