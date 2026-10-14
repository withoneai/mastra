# Example: One in a Mastra app

A Mastra app that uses every part of `@withone/mastra`:

| File                                   | What it shows                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/mastra/agents/ops.ts`             | An agent with Cal.com (two typed tools) and Linear (discover mode), using your One key           |
| `src/mastra/agents/personal.ts`        | An agent that acts for each signed-in user with their own One Connect grant                      |
| `src/mastra/one-connect.ts`            | The One Connect sign-in routes (`/one/authorize`, `/one/callback`) and a demo user store         |
| `src/mastra/workflows/issue-digest.ts` | A workflow with a One action as a step                                                           |
| `src/mastra/index.ts`                  | One in Studio's agent editor, and a webhook-relay route (`/one/events`) that starts the workflow |

## Run it

The example uses this repo's build of `@withone/mastra`, so build it first:

```bash
pnpm install && pnpm build               # in the repo root
cd examples/studio && pnpm install --ignore-workspace
```

`.env`:

```bash
ONE_SECRET=sk_live_…              # your One API key
ANTHROPIC_API_KEY=…               # or OPENAI_API_KEY=… and MODEL=openai/gpt-5.5
ONE_RELAY_SECRET=any-long-random-string

# Optional: per-user mode (a Connect app from app.withone.ai → Developers → Connect,
# with callback http://localhost:4111/one/callback)
ONE_CLIENT_ID=…
ONE_CLIENT_SECRET=…
ONE_CONNECT_KEY=sk_live_…
```

```bash
MASTRA_EXPERIMENTAL_UI=true npx mastra dev     # Studio at http://localhost:4111
```

The agents use Cal.com and Linear. Change the platforms in `src/mastra/agents/` to apps you've connected.

## Try it

- **Chat:** open **Ops copilot** in Studio and ask for your latest Linear issues.
- **No-code agents:** **Agents → Create agent → Tools → One**.
- **Per-user mode:** open `http://localhost:4111/one/authorize?as=alice#one_connector=linear` and grant Linear. Then ask as alice:
  ```bash
  curl -s -X POST localhost:4111/api/agents/personal/generate -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"What are my latest Linear issues?"}],"requestContext":{"userId":"alice"}}'
  ```
  The demo has no real sign-in: `?as=alice` stands in for "which of my users clicked Connect".
- **Webhook trigger:** send a signed event to `/one/events`:
  ```bash
  BODY='{"relayEventId":"1","platform":"stripe","eventType":"charge.failed","payload":{},"timestamp":"2026-01-01T00:00:00Z","connectionId":"1"}'
  SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$ONE_RELAY_SECRET" -hex | awk '{print $NF}')"
  curl -s -X POST localhost:4111/one/events -H "x-relay-signature: $SIG" --data-raw "$BODY"   # {"accepted":true,"runId":"…"}
  ```
