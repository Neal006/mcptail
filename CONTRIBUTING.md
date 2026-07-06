# Contributing to mcptap

Thanks for helping make MCP traffic visible. PRs of every size are welcome —
the fastest reviews go to small, focused changes.

## Dev setup

```bash
git clone https://github.com/Neal006/mcptap
cd mcptap
npm install        # also installs the pre-commit hook
npm run check      # lint + typecheck + tests — must pass before every commit
npm run build      # dist/cli.js + dist/ui
```

Try your build end to end:

```bash
node dist/cli.js run --label demo -- npx -y @modelcontextprotocol/server-everything
# in another terminal:
node dist/cli.js ui
```

UI development with hot reload: `node dist/cli.js ui` (API on :4747), then
`npx vite ui` and open the Vite dev server — `/api` is proxied.

## Adding a client adapter

The most-wanted contribution. An adapter tells mcptap where a client keeps its
MCP config. It's one small file:

```ts
// src/adapters/zed.ts
import { join } from "node:path";
import { type ClientAdapter, userHome } from "./types.js";

export const zed: ClientAdapter = {
  name: "zed",
  candidates(cwd) {
    return [{ path: join(userHome(), ".config", "zed", "settings.json"), serversKey: "context_servers" }];
  },
};
```

Then register it in `src/adapters/index.ts` and add a fixture round-trip test
in `tests/taps.test.ts` (copy an existing one). That's the whole PR.

## Adding a model to the pricing table

Edit [`src/pricing.json`](src/pricing.json) — keep entries alphabetical, use
the provider's published input price per million tokens, and link the pricing
page in your PR description.

## Ground rules

- **Conventional commits**: `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...` — release-please builds the changelog from these.
- **Tests ride with the code**: a module change without its test change is an incomplete PR.
- **The proxy never breaks a session**: anything on the traffic path must degrade to a plain pipe on failure, never throw.
- **Recording is passive**: mcptap must never mutate, reorder, or delay traffic.
- `npm run check` is the same gate CI runs — if it passes locally, CI passes.

## Reporting bugs

Open an issue with your OS, Node version, client (Claude Code / Cursor / VS
Code), and — if you can — the relevant lines from the session `.jsonl` file
(scrub anything sensitive first).
