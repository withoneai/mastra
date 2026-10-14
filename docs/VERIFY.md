# Verifying @withone/mastra yourself

A start-to-end walkthrough. Every step was run on 2026-10-14 against the One **development** environment (`https://development-api.withone.ai`) with `@mastra/core` 1.77.0. Each step lists the result to expect.

Run it in WSL/Linux or macOS. Studio at `http://localhost:4111` also opens from a Windows browser while the server runs in WSL.

## 0. Prerequisites

- Node ≥ 22.13 (`node -v`), pnpm (`npm i -g pnpm`), git, and `gh` for cloning the private repo.
- A One secret key. Either:
  - you're logged in with the One CLI (`one whoami` shows the environment and `apiBase`), or
  - you have a key (`sk_test_…` or `sk_live_…`) to put in `.env` in step 2.
- The **app connections** the steps use. The examples use `linear` and `cal-com`, which the dev sandbox account has. On another account, swap in apps you have connected (`one list`).
- *(Optional, step 6 only)* A model key for chatting with the agent, e.g. `ANTHROPIC_API_KEY`.

## 1. Clone, install, run the offline tests

```bash
gh repo clone withoneai/one-mastra && cd one-mastra
pnpm install
pnpm typecheck && pnpm test
```

**Expect:** no type errors and `Tests 53 passed (53)`. These run against fake One and One Connect APIs, with real Mastra agents and workflows (in-memory storage). One test also checks the real `@withone/connect` client against the interface.

## 2. Live checks against your One account (read-only)

First give the repo your One key. From the repo root:

```bash
cp .env.example .env
```

Then edit `.env`:

```bash
ONE_SECRET=sk_test_…                                # your key
ONE_BASE_URL=https://development-api.withone.ai     # dev; delete this line for production
```

The `pnpm smoke*` scripts load this `.env` automatically. Values exported in your shell take precedence. Keep the key and base URL matched: a dev key against the production URL, or the other way round, fails with 401.

```bash
pnpm smoke
```

**Expect:**

- `resolved N tools` listing `cal_com_get_event_types`, `cal_com_get_my_profile` and the three `one_*` tools.
- A warning that `linear` has ~488 actions, so it uses search/run tools.
- `cal_com_get_event_types → 200 {…}` with real data.
- `one_run_action → 200` with real Linear issues.
- A second, cached resolve that takes a few ms.

```bash
pnpm smoke:provider
```

**Expect:**

- `health { ok: true … }`, ~996 toolkits, and Linear's list-issues search.
- Your Linear connections listed, with `getConnectionStatus` returning `connected: true` for a real key and `false` for a fake one.
- `execute → 200` with real issues.
- `authorize` returns a `https://development.withone.ai/?env=test#open=linear` URL (`app.withone.ai` on production).
- `getAuthStatus` reports `pending`, and `failed` for an unknown id.

```bash
pnpm smoke:workflow
```

**Expect three lines:**

- `start → suspended {…"Approve \"List Issues\" on linear?"…}`
- `resume(approved) → success {"issues":[…],"email":"…"}`
- `resume(declined) → success result: {…"declined":true} | profile step ran: false`

The last line confirms that declining stops the workflow.

> If you use other apps, edit the platform names at the top of these three scripts.

## 3. `init` from an empty folder

The package isn't on npm yet, so build a tarball and point `init` at it.

`init` runs in a different folder, so it does **not** read the repo's `.env`. It uses your One CLI login, or else an exported `ONE_SECRET` / `ONE_BASE_URL`, or else `--secret` / `--base-url`. If you're not logged in with `one login`, add `--secret sk_test_… --base-url https://development-api.withone.ai` to the command below. It writes the key into the new project's own `.env`.

```bash
pnpm build && pnpm pack --pack-destination /tmp     # → /tmp/withone-mastra-0.0.0.tgz
mkdir -p ~/one-mastra-test && cd ~/one-mastra-test
node <path-to-repo>/dist/cli.js init my-agent \
  --platforms linear,cal-com,gemini \
  --package /tmp/withone-mastra-0.0.0.tgz -y
```

**Expect:**

```
✓ Signed in to One as … (test, https://development-api.withone.ai)
✓ Found N connections across M apps
  note: not connected yet: gemini; …          (only if you list an app you don't have)
✓ Created a Mastra project with create-mastra
✓ Wrote src/mastra/agents/one-agent.ts
✓ Updated src/mastra/index.ts (imports, agent, Studio provider)
✓ Added ONE_SECRET to .env
✓ Installed the one-mastra skill for coding agents (.agents/skills, .claude/skills)
✓ Installed @withone/mastra and @mastra/editor with npm
```

Check what it wrote:

- `src/mastra/index.ts` imports `MastraEditor`, `OneToolProvider` and `oneAgent`, and has `agents: { oneAgent, agent }` and `editor: new MastraEditor({ toolProviders: { one: new OneToolProvider() } })`.
- `.env` has `ONE_SECRET` (and `ONE_BASE_URL` if you set it), and `.env` is in `.gitignore`.
- Running `init` again changes nothing in `index.ts`, because it's idempotent.

## 4. Start it and look at Studio

```bash
cd my-agent && npm run dev
```

Open `http://localhost:4111`.

**Expect:**

1. **Agents** lists **One agent** (model `claude-sonnet-5-5`) next to the template's agent.
2. With the server running, a second terminal shows the agent's tools:
   ```bash
   curl -s localhost:4111/api/agents/one-agent | python3 -c "import json,sys;print(list(json.load(sys.stdin)['tools']))"
   ```
   You should see `connect_gemini`, plus tools for your other apps. Large apps such as Linear and Cal.com get `one_find_actions` / `one_get_action` / `one_run_action`.
3. Run a tool through Mastra's own API:
   ```bash
   curl -s -X POST localhost:4111/api/agents/one-agent/tools/one_find_actions/execute \
     -H 'content-type: application/json' -d '{"data":{"platform":"linear","query":"list issues"}}'
   curl -s -X POST localhost:4111/api/agents/one-agent/tools/connect_gemini/execute \
     -H 'content-type: application/json' -d '{"data":{}}'
   ```
   The first returns ranked Linear actions with "List Issues" first. The second returns `{"connectRequired":true,…,"url":"https://development.withone.ai/?env=test#open=gemini"}`.

## 5. One in Studio's agent editor (no code)

Studio 1.77 hides the **Create agent** button unless its experimental UI is on. Stop the step-4 server and restart it with:

```bash
MASTRA_EXPERIMENTAL_UI=true npm run dev
```

Then in Studio:

1. On **Agents**, click **Create agent**.
2. Fill in **Identity** (a name, and any provider/model, e.g. Anthropic / `claude-sonnet-5-5`) and **Instructions**. Both are required before **Create agent** turns on. The other steps (Agents, Scorers, Workflows, Memory, Variables) are optional.
3. In **Tools**, under integration tools, **One** shows as *Available* ("Act in 972+ apps through your One connections").
4. Click **One**. The left column lists all One apps. Studio draws that list and it has no search box, so either scroll to **Linear**, or type `linear` in the search box with **All** selected, which lists Linear's actions.
5. Click **Linear** and search `list issues`. "List Issues" is first (see `docs/screenshots/studio-one-linear-tools.png`). Tool descriptions read "POST /graphql" because Linear's actions have no description in One's catalog.
6. Tick **List Issues**, then **Add tools**. Studio doesn't ask for a connection; with none pinned, the tool uses your first working Linear connection, the same default as `oneTools()`.
7. Click **Create agent**.
8. Check the agent's tools from a terminal (use the id Studio gave it, e.g. `linear-helper`):
   ```bash
   curl -s localhost:4111/api/agents/linear-helper | python3 -c "import json,sys;print(list(json.load(sys.stdin)['tools']))"
   curl -s -X POST localhost:4111/api/agents/linear-helper/tools/linear_list_issues/execute \
     -H 'content-type: application/json' \
     -d '{"data":{"body":{"query":"query { issues(first: 3) { nodes { identifier title } } }","variables":{}}}}'; echo
   ```
   **Expect:** `['linear_list_issues']`, then `{"ok":true,"status":200,…}` with three real issues.

> Steps 1–8 were clicked through in Studio 1.77 on 2026-10-14. Step 8 failed (no tools) before `fix(provider)` cb56039: Studio saves no connection, and the provider rejected that.

To try **Connect** in the editor, pick an app you haven't connected. Studio opens One's dashboard on that app's connect dialog. After you connect, Studio's status poll turns *completed* and the new connection is tagged on One with an `oneauth_…` id.

## 6. Chat with the agent (needs a model key)

Add `ANTHROPIC_API_KEY=…` to `my-agent/.env` and restart `npm run dev`. In Studio, open **One agent** and ask:

> What are the three most recent issues in Linear?

**Expect:** tool calls `one_find_actions` → `one_get_action` → `one_run_action`, then an answer naming real issues. Then ask for something on an app you haven't connected (e.g. Gemini). The agent calls `connect_gemini` and gives you the link.

## 7. Trigger a workflow with a signed event

Use the example app, which registers `oneTrigger` on `/one/events` and an `issueDigest` workflow:

```bash
cd <repo>/examples/studio
cp ../../.env .env                                   # the example app reads its own .env
echo 'ONE_RELAY_SECRET=local-test-secret' >> .env
pnpm install --ignore-workspace
npx mastra dev                                       # stop the step-4 server first (port 4111)
```

Then, in another terminal:

```bash
BODY='{"relayEventId":"11111111-1111-1111-1111-111111111111","platform":"stripe","eventType":"charge.failed","payload":{"id":"ch_1"},"timestamp":"2026-10-14T08:00:00Z","connectionId":"22222222-2222-2222-2222-222222222222"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac local-test-secret -hex | awk '{print $NF}')"
curl -s -X POST localhost:4111/one/events -H "x-relay-signature: $SIG" --data-raw "$BODY"   # {"accepted":true,"runId":"…"}
curl -s -X POST localhost:4111/one/events -H "x-relay-signature: $SIG" --data-raw "$BODY"   # {"duplicate":true}
curl -s -X POST localhost:4111/one/events -H "x-relay-signature: sha256=00" --data-raw "$BODY" -w " %{http_code}\n"   # 401
curl -s "localhost:4111/api/workflows/issueDigest/runs/<runId>"   # status "success", result.trigger "charge.failed", real issues
```

For a **real** relay, the target URL must be public, because One blocks private addresses. Expose the server (e.g. `ngrok http 4111`), then point a relay at it as shown in the README's Triggers section.

## 8. Per-user mode (One Connect)

This needs a One Connect app, so it has only been tested against fakes and the real client's interface. To check it live:

1. Create an app under Dashboard → Developers → Connect, with callback `http://localhost:4111/api/one/callback`.
2. Mount `@withone/connect`'s authorize and callback routes on the Mastra server.
3. Configure `oneTools({ connect, userId, connectUrl })` as in the README.

**Expect:**

- A user with no grant gets only `connect_<app>` tools pointing at your authorize route.
- After they connect, their next message gets typed tools that act on *their* accounts.

## Cleaning up

- Stop the dev servers with Ctrl-C.
- Delete `~/one-mastra-test`. Its `.env` contains your One key.
