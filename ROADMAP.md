# Roadmap

v0.1 ships the core loop: tap → record → inspect → replay, stdio-only,
three clients. Everything below is up for grabs — each item links to a
tracking issue; comment there before starting so work doesn't collide.

## Next (v0.2)

- [ ] Streamable HTTP / SSE transport capture
- [ ] Windsurf, Zed, and Cline client adapters
- [ ] Search & filter in the dashboard timeline
- [ ] Session pruning: `mcptail clear` + max-size rotation

## Later

- [ ] Export a captured call as a regression test (`mcptail test`)
- [ ] HAR export for sharing sessions
- [ ] OpenTelemetry exporter
- [ ] Exact tokenizer adapters (opt-in) instead of chars/4
- [ ] Session diffing — compare two runs of the same server
- [ ] Homebrew tap

## Non-goals

- Cloud anything. mcptail stays local-first with no account.
- Modifying traffic. It's a tap, not a middleware framework.
