// The README's code samples, type-checked against the package by `pnpm typecheck` (never run).
// Keep each block identical to the README apart from the stubs and import paths.
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { ToolSearchProcessor } from '@mastra/core/processors'
import { RequestContext } from '@mastra/core/request-context'
import { createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { oneTools, type PlatformConfig } from '../src/index.js'
import { OneToolProvider } from '../src/provider.js'
import { oneStep } from '../src/workflows.js'
import { oneTrigger } from '../src/triggers.js'

declare const userStore: { loadUser(userId: string): Promise<string | null> }
declare const user: { id: string }
declare const message: string
const inputSchema = z.object({})
const outputSchema = z.object({})

// Add One to an agent
export const assistant = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions: 'Help the user across their apps. Use the tools; never invent data.',
  model: 'anthropic/claude-sonnet-5-5',
  defaultOptions: { maxSteps: 15 },
  tools: oneTools({
    platforms: {
      'cal-com': true,
      gmail: { allowTools: ['gmail_list_*', 'gmail_send_*'], requireApproval: 'writes' },
      linear: 'discover',
    },
  }),
})

// The simplest agent, registered and called
export const simple = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions: 'Help the user across their apps. Use the tools; never invent data.',
  model: 'anthropic/claude-sonnet-5-5',
  defaultOptions: { maxSteps: 15 },
  tools: oneTools({ platforms: { gmail: true, linear: true } }),
})
export const simpleMastra = new Mastra({ agents: { simple } })
const reply = await simple.generate('Summarise my unread email and my open Linear issues.')
console.log(reply.text)
console.log(Object.keys(await oneTools({ platforms: { gmail: 'all' } })()))

// Per-app options
oneTools({
  platforms: {
    'cal-com': true,
    gmail: { allowTools: ['gmail_list_*', 'gmail_send_*'], requireApproval: 'writes' },
    linear: 'discover',
  },
})

// 'all' + ToolSearchProcessor
new Agent({
  id: 'search',
  name: 'Search',
  instructions: 'x',
  model: 'anthropic/claude-sonnet-5-5',
  tools: oneTools({ platforms: { linear: 'all' } }),
  inputProcessors: [new ToolSearchProcessor({ tools: {}, includeResolvedTools: true })],
})

// Per-app options
export const gmail: PlatformConfig = {
  allowTools: ['gmail_list_*'],
  disallowTools: ['*_delete_*'],
  actions: ['Send Email'],
  requireApproval: 'writes',
  connectionKey: 'live::gmail::…',
  mode: 'discover',
}

// Studio
export const mastra = new Mastra({
  editor: new MastraEditor({
    toolProviders: { one: new OneToolProvider({ requireApproval: 'writes' }) },
  }),
})

// One Connect
oneTools({
  connect: {
    connectKey: process.env.ONE_CONNECT_KEY!,
    loadUser: (userId) => userStore.loadUser(userId),
  },
  userId: ({ requestContext }) => requestContext?.get('userId'),
  connectUrl: ({ platform }) => `/api/one/authorize#one_connector=${platform}`,
  platforms: { gmail: 'discover', linear: 'discover' },
})
assistant.generate(message, { requestContext: new RequestContext([['userId', user.id]]) })

// Workflow steps
const refund = await oneStep({ platform: 'stripe', action: 'stripe_create_a_refund', requireApproval: true })
const notify = await oneStep({ platform: 'slack', action: 'Send Message' })

export const refundFlow = createWorkflow({ id: 'refund', inputSchema, outputSchema })
  .then(refund)
  .map(async ({ getStepResult }) => ({
    body: { channel: '#finance', text: `Refunded ${(getStepResult(refund).data as { id: string }).id}` },
  }))
  .then(notify)
  .commit()

// Triggers
new Mastra({
  workflows: { refundFlow },
  server: {
    apiRoutes: [oneTrigger({ path: '/one/stripe', workflow: 'refundFlow', eventTypes: ['charge.failed'] })],
  },
})
