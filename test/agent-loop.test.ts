import { describe, expect, it } from 'vitest'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core'
import { ToolSearchProcessor } from '@mastra/core/processors'
import { LibSQLStore } from '@mastra/libsql'
import { oneTools } from '../src/tools.js'

/** One's API with a cal-com connection: a GET read, a POST write, and filler actions. */
function fakeOne(extra = 0) {
  const runs: string[] = []
  const actions = [
    { systemId: 'conn_mod_def::get', title: 'Get Event Type', key: 'k0', method: 'GET', path: '/event-types', tags: [] },
    { systemId: 'conn_mod_def::book', title: 'Create Booking', key: 'k1', method: 'POST', path: '/bookings', tags: [] },
    ...Array.from({ length: extra }, (_, i) => ({
      systemId: `conn_mod_def::a${i}`,
      title: `Archive Widget ${i}`,
      key: `a${i}`,
      method: 'POST',
      path: `/w/${i}`,
      tags: [],
    })),
  ]
  const doc = (a: (typeof actions)[number]) => ({
    _id: a.systemId,
    title: a.title,
    method: a.method,
    path: a.path,
    tags: a.tags,
    ioSchema: { inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { note: { type: 'string' } } } } } },
  })
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/v1/vault/connections') {
      return json({ rows: [{ key: 'test::cal-com::default::1', platform: 'cal-com', state: 'operational', active: true }], pages: 1 })
    }
    if (url.pathname === '/v1/knowledge' && url.searchParams.get('connectionPlatform')) return json({ rows: actions.map(doc), pages: 1 })
    if (url.pathname === '/v1/knowledge') return json({ rows: actions.filter((a) => a.systemId === url.searchParams.get('_id')).map(doc) })
    if (url.pathname.startsWith('/v1/available-actions/')) return json({ rows: actions, pages: 1, total: actions.length })
    if (url.pathname.startsWith('/v1/passthrough/')) {
      runs.push(`${init?.method} ${url.pathname.slice('/v1/passthrough'.length)}`)
      return json({ ok: 1 })
    }
    return json({})
  }) as typeof fetch
  return { fetchImpl, runs }
}

type Part = Record<string, unknown>
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const call = (id: string, toolName: string, input: unknown): Part => ({
  type: 'tool-call',
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
})
const say = (text: string): Part[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
]

/** A stand-in model that plays a fixed script, one entry per model call, and records the tools it was offered. */
function scriptedModel(script: Part[][]) {
  const offered: string[][] = []
  const model = {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('stream only')
    },
    async doStream(opts: any) {
      offered.push((opts.tools ?? []).map((t: any) => t.name))
      const parts = script[offered.length - 1] ?? say('done')
      const toolCall = parts.some((p) => p.type === 'tool-call')
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of [
              { type: 'stream-start', warnings: [] },
              ...parts,
              { type: 'finish', finishReason: toolCall ? 'tool-calls' : 'stop', usage },
            ])
              c.enqueue(p)
            c.close()
          },
        }),
      }
    },
  }
  return { model: model as any, offered }
}

function register(agent: Agent) {
  new Mastra({ agents: { agent }, storage: new LibSQLStore({ id: 't', url: ':memory:' }), logger: false })
  return agent
}

describe("requireApproval: 'writes' in a real agent run", () => {
  it('pauses a write until approved, then runs it', async () => {
    const one = fakeOne()
    const { model } = scriptedModel([[call('c1', 'cal_com_create_booking', { body: { note: 'x' } })], say('booked')])
    const agent = register(
      new Agent({
        id: 'agent',
        name: 'agent',
        instructions: 'x',
        model,
        tools: oneTools({
          secret: 'sk_test',
          fetch: one.fetchImpl,
          platforms: { 'cal-com': { requireApproval: 'writes' } },
          onWarning: () => {},
        }),
      }),
    )

    const first = await agent.stream('book it')
    await first.consumeStream()
    expect(await first.finishReason).toBe('suspended')
    expect(one.runs).toEqual([])

    const resumed = await agent.approveToolCall({ runId: first.runId })
    expect(await resumed.text).toBe('booked')
    expect(one.runs).toEqual(['POST /bookings'])
  })

  it('runs a read straight through', async () => {
    const one = fakeOne()
    const { model } = scriptedModel([[call('c1', 'cal_com_get_event_type', {})], say('here')])
    const agent = register(
      new Agent({
        id: 'agent',
        name: 'agent',
        instructions: 'x',
        model,
        tools: oneTools({
          secret: 'sk_test',
          fetch: one.fetchImpl,
          platforms: { 'cal-com': { requireApproval: 'writes' } },
          onWarning: () => {},
        }),
      }),
    )
    const out = await agent.stream('list')
    expect(await out.text).toBe('here')
    expect(one.runs).toEqual(['GET /event-types'])
  })
})

describe("'all' with ToolSearchProcessor in a real agent run", () => {
  it('searches, loads and runs a One tool that was never in the prompt up front', async () => {
    const one = fakeOne(60)
    const { model, offered } = scriptedModel([
      [call('c1', 'search_tools', { query: 'event type' })],
      [call('c2', 'load_tool', { toolName: 'cal_com_get_event_type' })],
      [call('c3', 'cal_com_get_event_type', {})],
      say('done'),
    ])
    const agent = register(
      new Agent({
        id: 'agent',
        name: 'agent',
        instructions: 'x',
        model,
        defaultOptions: { maxSteps: 10 },
        tools: oneTools({ secret: 'sk_test', fetch: one.fetchImpl, platforms: { 'cal-com': 'all' }, onWarning: () => {} }),
        inputProcessors: [new ToolSearchProcessor({ tools: {}, includeResolvedTools: true })],
      }),
    )
    const out = await agent.stream('what event types do I have?')
    expect(await out.text).toBe('done')
    expect(offered[0]).not.toContain('cal_com_get_event_type')
    expect(offered[2]).toContain('cal_com_get_event_type')
    expect(one.runs).toEqual(['GET /event-types'])
  })
})
