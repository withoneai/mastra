---
name: one-mastra
description: Give Mastra agents and workflows access to apps connected through One (Gmail, Slack, Stripe, HubSpot and 970+ more) with @withone/mastra. Use when adding app integrations, third-party tools, per-user connections, approval gates on app actions, or webhook-triggered workflows to a Mastra project.
---

# @withone/mastra

One holds the user's app connections and auth; `@withone/mastra` turns them into Mastra tools, workflow steps and triggers. Never hand-write API clients or OAuth for an app One supports.

## Agent tools

```ts
import { Agent } from '@mastra/core/agent'
import { oneTools } from '@withone/mastra'

export const agent = new Agent({
  id: 'ops',
  name: 'Ops',
  instructions: '…',
  model: 'anthropic/claude-sonnet-5-5',
  tools: oneTools({
    platforms: {
      stripe: { allowTools: ['stripe_list_*', 'stripe_create_a_refund'], requireApproval: ['stripe_create_*'] },
      slack: true,          // typed tool per action, or search/run tools if the app has > 40 actions
      linear: 'discover',   // always search/run tools: one_find_actions, one_get_action, one_run_action
    },
  }),
})
```

- Platform keys are One slugs (`google-calendar`, `cal-com`). List them with `one list` or `one platforms`.
- Tool ids are `<platform>_<action title>` in snake_case, e.g. `cal_com_get_event_types`. Use them in `allowTools`, `disallowTools` and `requireApproval` globs.
- Tool input is `{ path?, query?, body? }` from the action's schema. Results are `{ ok, status, data }`.
- An app that isn't connected becomes `connect_<platform>`, which returns `{ connectRequired, url }`. Tell the agent to give the user the link.
- To combine with other tools: `tools: async (ctx) => ({ ...(await one(ctx)), myTool })`.

## Per-user access (One Connect)

```ts
import { createOneConnect } from '@withone/connect/server'
const oneConnect = createOneConnect({ /* clientId, clientSecret, redirectUri, connectKey, userStore */ })

oneTools({
  connect: oneConnect,
  userId: ({ requestContext }) => requestContext.get('userId'),
  connectUrl: ({ platform }) => `/api/one/authorize?connector=${platform}`,
  platforms: { gmail: true },
})
```

Pass the user on each call: `agent.generate(msg, { requestContext: new RequestContext([['userId', id]]) })`.

## Mastra Studio

```ts
import { MastraEditor } from '@mastra/editor'
import { OneToolProvider } from '@withone/mastra/provider'

new Mastra({ storage, editor: new MastraEditor({ toolProviders: { one: new OneToolProvider() } }) })
```

One then appears in Studio's tool picker: browse apps, connect, and attach actions to agents without code.

## Workflow steps

```ts
import { oneStep } from '@withone/mastra/workflows'

const refund = await oneStep({ platform: 'stripe', action: 'stripe_create_a_refund', requireApproval: true })
createWorkflow({ … }).then(refund).commit()
```

`requireApproval` suspends the run; resume with `run.resume({ step: refund, resumeData: { approved: true } })`. A declined approval ends the workflow unless `onDecline: 'continue'`. Non-2xx responses fail the step.

## Triggers

```ts
import { oneTrigger } from '@withone/mastra/triggers'

new Mastra({ server: { apiRoutes: [oneTrigger({ path: '/one/stripe', workflow: 'refundFlow', eventTypes: ['charge.failed'] })] } })
```

Set `ONE_RELAY_SECRET` to the relay's signing secret. Point a One relay `url` action at the route (`one relay create … && one relay activate <id> --actions '[{"type":"url","url":"https://…/one/stripe","secret":"…"}]'`).

## Environment

- `ONE_SECRET`: One secret key (`sk_live_…` / `sk_test_…`).
- `ONE_BASE_URL`: only for a non-production One API.
- `ONE_RELAY_SECRET`: for `oneTrigger`.
