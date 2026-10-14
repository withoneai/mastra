# @withone/mastra

Use every app connected through [One](https://withone.ai) (972+ platforms) as Mastra tools.

> **Status: Phase 1 prototype, not published.** `oneTools()` works against a live One account. Studio provider, workflow steps, triggers and `init` are still to come (see `../mastra-one/mastra-one-proposal.md`).

```ts
import { Agent } from '@mastra/core/agent'
import { oneTools } from '@withone/mastra'

export const opsAgent = new Agent({
  id: 'ops',
  name: 'Ops copilot',
  instructions: 'Help the user run operations across their apps.',
  model: 'anthropic/claude-sonnet-5-5',
  tools: oneTools({
    platforms: {
      'cal-com': true,
      gmail: { allowTools: ['gmail_list_*', 'gmail_create_draft'], requireApproval: ['gmail_create_*'] },
      linear: 'discover',
    },
  }),
})
```

Set `ONE_SECRET` (and `ONE_BASE_URL` for a non-production core).

## What you get

- **One named, typed tool per action**, e.g. `cal_com_get_event_types`. Input schemas come from One's per-action `ioSchema`; headers and connection keys are stripped so the model never sees credentials, and Mastra validates inputs before anything is sent.
- **Discover mode** for large platforms. A platform with more than `maxToolsPerPlatform` (default 40) actions and no `actions`/`allowTools` filter gets three tools instead — `one_find_actions`, `one_get_action`, `one_run_action` — restricted to the platforms you enabled.
- **Per-request resolution.** `oneTools()` returns a resolver Mastra calls per request, so new connections show up without a redeploy. Catalogs and schemas are cached (10 min); connections for 30 s.
- **Per-user access** via One Connect grant keys: `connectUserId: ({ requestContext }) => requestContext.get('userId')` sends `X-One-Connect-User-Id`. *(Not yet verified against a live Connect app.)*
- **Approvals**: `requireApproval: true | ['glob_*']` per platform maps to Mastra's tool approval.
- **Bounded output**: results over `maxResultChars` (default 30 000) are truncated before they reach the model.

## Options

| Option | Default | |
|---|---|---|
| `platforms` | — | `{ [slug]: true \| 'discover' \| PlatformConfig }` |
| `secret` | `ONE_SECRET` | One secret key |
| `baseUrl` | `ONE_BASE_URL` → `https://api.withone.ai` | |
| `connectUserId` | — | `(args) => string \| undefined` |
| `maxToolsPerPlatform` | 40 | |
| `cacheTtlMs` | 600 000 | |
| `maxResultChars` | 30 000 | |
| `onWarning` | `console.warn` | each distinct warning is reported once |

`PlatformConfig`: `connectionKey`, `actions` (ids or exact titles), `allowTools`, `disallowTools`, `requireApproval`, `mode: 'typed' | 'discover'`.

## Development

```bash
pnpm install
pnpm test          # offline, against a fake One API
pnpm typecheck
ONE_SECRET=sk_test_… ONE_BASE_URL=https://development-api.withone.ai pnpm smoke   # live, read-only
```

Peer dependencies: `@mastra/core >=1.76 <2`, `zod ^3.25 || ^4`. Node ≥ 22.13.
