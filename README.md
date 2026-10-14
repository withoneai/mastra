# @withone/mastra

Give your [Mastra](https://mastra.ai) agents and workflows the apps you've connected on [One](https://withone.ai): 972+ apps including Gmail, Slack, Linear, HubSpot and Stripe. One handles auth, so there's no OAuth code and no provider SDKs.

![One in Mastra Studio's tool picker](docs/studio-one-tools.png)

- [Quick start](#quick-start)
- [Add One to an agent](#add-one-to-an-agent)
- [Build agents in Mastra Studio](#build-agents-in-mastra-studio)
- [Act for each of your users (One Connect)](#act-for-each-of-your-users-one-connect)
- [Run One actions in workflows](#run-one-actions-in-workflows)
- [Start workflows from app events](#start-workflows-from-app-events)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Quick start

You need a One account with a few apps connected ([app.withone.ai](https://app.withone.ai)) and a model key (e.g. `ANTHROPIC_API_KEY`).

```bash
npx @withone/mastra init my-agent --platforms gmail,linear,slack
cd my-agent && npm run dev        # Mastra Studio at http://localhost:4111
```

`init` creates a Mastra project (or updates the one in the current folder) and:

- adds a **One agent** whose tools are your connected apps,
- registers One in Studio's agent editor,
- puts your One key in `.env` (from your [One CLI](https://github.com/withoneai/cli) login, `ONE_SECRET`, or `--secret`),
- installs a skill that teaches coding agents (Claude Code, Cursor, Codex) how to use this package.

Add your model key to `.env`, open Studio, pick **One agent**, and ask _"What are my three most recent Linear issues?"_

**Or try it from a clone**, with no project at all: put `ONE_SECRET` and a model key in `.env`, then ask a question about your apps.

```bash
git clone https://github.com/withoneai/mastra && cd mastra && pnpm install
npx tsx examples/agent.ts "What are my Gmail labels?"
```

The One agent uses Anthropic by default. For another provider, set its key and `MODEL` in `.env`, e.g. `OPENAI_API_KEY=…` and `MODEL=openai/gpt-5.5`.

## Add One to an agent

```bash
npm install @withone/mastra
```

```bash
# .env
ONE_SECRET=sk_live_…        # your One API key, from app.withone.ai
```

Give an agent every app you've connected:

```ts
import { Agent } from '@mastra/core/agent'
import { oneTools } from '@withone/mastra'

export const assistant = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions: 'Help the user across their apps. Use the tools; never invent data.',
  model: 'anthropic/claude-sonnet-5-5',
  defaultOptions: { maxSteps: 15 },
  tools: oneTools(),
})
```

Or only some apps, by their One name: `oneTools({ platforms: { gmail: true, linear: true } })`.

Register it and use it like any Mastra agent:

```ts
import { Mastra } from '@mastra/core'

export const mastra = new Mastra({ agents: { assistant } })

const reply = await assistant.generate('Summarise my unread email and my open Linear issues.')
console.log(reply.text)
```

- **App names** are One's platform names, used in `platforms`: `gmail`, `google-calendar`, `cal-com`, `hubspot`. `one list` (One CLI) shows the ones you've connected.
- **Tool ids** are the app name plus the action title in snake_case: Gmail's "Send Email" is `gmail_send_email`. To list an app's ids, log `Object.keys(await oneTools({ platforms: { gmail: 'all' } })())`, or browse the app in Studio's One picker.
- **Credentials never reach the model.** The agent sees action names and input schemas; One adds the auth to each call.
- **New connections appear on the next message.** The tools are worked out on every request, so no restart is needed.

### How each app's tools look

| Setting      | What the agent gets                                                              | Use it for                                                                    |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `true`       | One typed tool per action, e.g. `cal_com_get_event_types`, with its input schema | Apps with up to 40 actions, or a filtered set                                 |
| `'discover'` | Three tools: `one_find_actions` → `one_get_action` → `one_run_action`            | Big apps (Linear has ~490 actions). One picks the action and returns its docs |
| `'all'`      | A typed tool for every action, with no cap                                       | Big apps, together with Mastra's `ToolSearchProcessor` (below)                |

With no `platforms` at all, every connected app goes through the discover tools. An app with more than 40 actions and no filter switches to `'discover'` automatically. Discover mode takes a few steps per answer, so give the agent `maxSteps` of 10 or more.

With `'all'`, add Mastra's tool search so the model only loads the tools a task needs:

```ts
import { ToolSearchProcessor } from '@mastra/core/processors'

new Agent({
  // …
  tools: oneTools({ platforms: { linear: 'all' } }),
  inputProcessors: [new ToolSearchProcessor({ tools: {}, includeResolvedTools: true })],
})
```

### Per-app options

Pass an object instead of `true` to narrow an app or add approvals:

```ts
oneTools({
  platforms: {
    'cal-com': true,
    gmail: { allowTools: ['gmail_list_*', 'gmail_send_*'], requireApproval: 'writes' },
    linear: 'discover',
  },
})
```

Everything an app accepts:

```ts
gmail: {
  allowTools: ['gmail_list_*'],      // keep only these tool ids (globs)
  disallowTools: ['*_delete_*'],     // drop these
  actions: ['Send Email'],           // or pick actions by title or One action id
  requireApproval: 'writes',         // pause for a human: true, 'writes', or tool-id globs
  connectionKey: 'live::gmail::…',   // use this connection instead of the first working one
  mode: 'discover',                  // 'typed' | 'discover' | 'all'
}
```

- **`requireApproval: 'writes'`** pauses only actions that change data. GET reads; PUT, PATCH and DELETE write; a POST is judged by its title, so "List Issues" runs and "Create Issue" waits. Studio shows an approve/decline card; in code, resume with `agent.approveToolCall({ runId })`.
- **An app you haven't connected** becomes a `connect_<app>` tool. The agent calls it and hands the user a link to connect the app.
- **Errors go to the model, not up the stack.** A failed call returns `{ ok: false, status, data }` with the provider's message, so the agent can fix its request and retry.
- **Large responses** are cut at 30,000 characters (`maxResultChars`) before they reach the model.

To mix One's tools with your own: `tools: async (ctx) => ({ ...(await one(ctx)), myTool })`, where `const one = oneTools({ … })`.

## Build agents in Mastra Studio

Register One as a tool provider and anyone on your team can build agents with One's apps in Studio, without code:

```ts
import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { OneToolProvider } from '@withone/mastra/provider'

export const mastra = new Mastra({
  // …agents, storage
  editor: new MastraEditor({
    toolProviders: { one: new OneToolProvider({ requireApproval: 'writes' }) },
  }),
})
```

In Studio go to **Agents → Create agent → Tools → One**. Pick an app, search its actions, tick the ones you want and save. The agent runs them with your first working connection for that app. Apps you haven't connected offer a **Connect** button that opens One.

> In Mastra 1.77, Studio only shows the **Create agent** button when started with `MASTRA_EXPERIMENTAL_UI=true npm run dev`.

## Act for each of your users (One Connect)

If you're building a product, each of your users can connect _their own_ apps, and your agent acts with exactly the access they granted.

1. Create a Connect app at [app.withone.ai](https://app.withone.ai) → **Developers → Connect** and register your callback URL.
2. Add the sign-in routes with [`@withone/connect`](https://www.npmjs.com/package/@withone/connect) (`createOneConnect` and `createOneConnectRoutes`). Its `userStore` saves one reference per user.
3. Give `oneTools` the Connect key, the same `loadUser`, and a way to tell which user a request is for:

```ts
oneTools({
  connect: {
    connectKey: process.env.ONE_CONNECT_KEY!,
    loadUser: (userId) => userStore.loadUser(userId),
  },
  userId: ({ requestContext }) => requestContext?.get('userId'),
  connectUrl: ({ platform }) => `/api/one/authorize#one_connector=${platform}`,
  platforms: { gmail: 'discover', linear: 'discover' },
})

// on each request
agent.generate(message, { requestContext: new RequestContext([['userId', user.id]]) })
```

- A user only gets tools for apps they granted. Everything else is a `connect_<app>` tool pointing at your authorize route. (Leave out `platforms` to give each user every app they granted, without connect links.)
- If they revoke access, their next request gets connect links again.
- A call outside what they granted returns `blockedByGrant: true`.
- A request without a user gets no One tools.

[`examples/studio`](examples/studio) has a working setup.

## Run One actions in workflows

`oneStep` turns one One action into a workflow step, with its input schema from One's catalog:

```ts
import { createWorkflow } from '@mastra/core/workflows'
import { oneStep } from '@withone/mastra/workflows'

const refund = await oneStep({ platform: 'stripe', action: 'stripe_create_a_refund', requireApproval: true })
const notify = await oneStep({ platform: 'slack', action: 'Send Message' })

export const refundFlow = createWorkflow({ id: 'refund', inputSchema, outputSchema })
  .then(refund)
  .map(async ({ getStepResult }) => ({
    body: { channel: '#finance', text: `Refunded ${(getStepResult(refund).data as { id: string }).id}` },
  }))
  .then(notify)
  .commit()
```

- `action` is a tool id, a One action id, or the action's exact title.
- The step returns `{ ok, status, data }`, where `data` is the app's response.
- `requireApproval: true` suspends the run until `run.resume({ step: refund, resumeData: { approved: true } })`. A declined approval ends the workflow, unless you pass `onDecline: 'continue'`.
- A non-2xx response fails the step, unless you pass `failOnError: false`.

## Start workflows from app events

`oneTrigger` adds a route that starts a workflow whenever One's webhook relay delivers an event (a failed charge, a new issue, …):

```ts
import { oneTrigger } from '@withone/mastra/triggers'

new Mastra({
  workflows: { refundFlow },
  server: {
    apiRoutes: [oneTrigger({ path: '/one/stripe', workflow: 'refundFlow', eventTypes: ['charge.failed'] })],
  },
})
```

It checks the relay signature (`ONE_RELAY_SECRET`), ignores repeats and unlisted event types, and answers `202` with the run id. Point a relay at it with the One CLI:

```bash
one relay create --connection-key <stripe-key> --create-webhook --event-filters '["charge.failed"]'
one relay activate <id> --actions '[{"type":"url","url":"https://<your-app>/one/stripe","secret":"<ONE_RELAY_SECRET>"}]'
```

## Configuration

| Variable           | Used for                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| `ONE_SECRET`       | Your One API key. Everything except per-user mode                                   |
| `ONE_RELAY_SECRET` | Verifying webhook-relay events (`oneTrigger`)                                       |
| `ONE_BASE_URL`     | A non-production One API, e.g. `https://development-api.withone.ai`                 |
| `ONE_APP_URL`      | The One dashboard that connect links open (defaults to the one paired with the API) |

Every option can also be passed in code (`secret`, `baseUrl`, …).

**Requirements:** Node 22.13+, `@mastra/core` 1.76+, and `zod` 3.25+ or 4. `@mastra/editor` only for the Studio provider. Works from both `import` and `require`.

**Coding agents:** `init` installs the skill for you; otherwise run `npx skills add withoneai/mastra`.

## Troubleshooting

| You see                                                          | Why, and the fix                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The agent calls tools but gives an empty answer                  | It ran out of steps. Discover mode needs about four per answer (find → get → run → reply); set `defaultOptions: { maxSteps: 15 }`  |
| `401` from One                                                   | The key and the API don't match, e.g. a development key against production. Set `ONE_BASE_URL` to the API your key is for          |
| A tool you listed in `allowTools` or picked in Studio is missing | The id doesn't match an action. Check the ids as shown above; unknown ids are skipped                                              |
| `connect_<app>` instead of the app's tools                       | The app has no working connection on One (or, in per-user mode, the user hasn't granted it). Connect it and send the message again |
| No **Create agent** button in Studio                             | Mastra 1.77 hides it; start Studio with `MASTRA_EXPERIMENTAL_UI=true`                                                              |
| A write runs without asking                                      | Add `requireApproval: 'writes'` (or `true`) to that app                                                                            |

## Licence

Apache-2.0
