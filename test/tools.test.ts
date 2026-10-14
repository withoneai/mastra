import { describe, expect, it } from 'vitest'
import { oneTools } from '../src/tools.js'

interface Call {
  url: URL
  init?: RequestInit
}

function fakeOne(opts: { actions?: number; findFails?: boolean } = {}) {
  const calls: Call[] = []
  const actions = Array.from({ length: opts.actions ?? 2 }, (_, i) =>
    i === 0
      ? { systemId: 'conn_mod_def::get', title: 'Get Event Type', key: 'k0', method: 'GET', path: '/event-types/{{id}}', tags: [] }
      : i === 1
        ? {
            systemId: 'conn_mod_def::create',
            title: 'Create Booking',
            key: 'k1',
            method: 'POST',
            path: '/v1/cal-com/create-booking',
            tags: ['custom'],
          }
        : { systemId: `conn_mod_def::a${i}`, title: `Action ${i}`, key: `k${i}`, method: 'GET', path: `/a/${i}`, tags: [] },
  )
  const knowledge: Record<string, unknown> = {
    'conn_mod_def::get': {
      _id: 'conn_mod_def::get',
      title: 'Get Event Type',
      method: 'GET',
      path: '/event-types/{{id}}',
      tags: [],
      connectionPlatform: 'cal-com',
      ioSchema: {
        inputSchema: {
          type: 'object',
          description: 'Fetch one event type.',
          properties: { path: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
          required: ['path'],
        },
      },
    },
    'conn_mod_def::create': {
      _id: 'conn_mod_def::create',
      title: 'Create Booking',
      method: 'POST',
      path: '/v1/cal-com/create-booking',
      tags: ['custom'],
      connectionPlatform: 'cal-com',
      knowledge: '# Create Booking\n\n## Description\n\nBooks a slot.\n\n## Other\n\nx',
      ioSchema: {
        inputSchema: {
          type: 'object',
          properties: {
            body: {
              type: 'object',
              properties: { connectionKey: { type: 'string' }, start: { type: 'string' } },
              required: ['connectionKey', 'start'],
            },
          },
          required: ['body'],
        },
      },
    },
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (url.pathname === '/v1/vault/connections') {
      return json({ rows: [{ key: 'test::cal-com::default::1', platform: 'cal-com', state: 'operational', active: true }], pages: 1 })
    }
    if (url.pathname.startsWith('/v1/available-actions/search/')) return json(actions.slice(0, 2))
    if (url.pathname === '/v1/available-actions/find') {
      if (opts.findFails) return json({ error: 'nope' }, 500)
      const [{ platform, intent }] = JSON.parse(String(init!.body)).requests
      return json([
        {
          platform,
          intent,
          confidence: 0.92,
          selected: [{ ...actions[0], knowledge: '# Get Event Type\n\nPass the id in the path.' }],
          alternatives: [actions[1]],
        },
      ])
    }
    if (url.pathname.startsWith('/v1/available-actions/')) return json({ rows: actions, pages: 1, total: actions.length })
    if (url.pathname === '/v1/knowledge' && url.searchParams.get('connectionPlatform')) {
      return json({
        rows: actions.map(
          (a) => knowledge[a.systemId] ?? { _id: a.systemId, title: a.title, method: a.method, path: a.path, tags: a.tags },
        ),
        pages: 1,
      })
    }
    if (url.pathname === '/v1/knowledge') {
      const row = knowledge[url.searchParams.get('_id')!]
      return row ? json({ rows: [row] }) : json({ rows: [] })
    }
    if (url.pathname.startsWith('/v1/passthrough/')) return json({ echoed: true })
    return json({ error: 'unexpected' }, 404)
  }) as typeof fetch

  return { calls, fetchImpl }
}

const quiet = () => {}

describe('oneTools', () => {
  it('creates one typed tool per action with credentials hidden from the schema', async () => {
    const { fetchImpl } = fakeOne()
    const tools = await oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': true }, onWarning: quiet })()
    expect(Object.keys(tools).sort()).toEqual(['cal_com_create_booking', 'cal_com_get_event_type'])

    const create = tools.cal_com_create_booking as any
    expect(create.description).toBe('Create Booking (cal-com). Books a slot.')
    expect(JSON.stringify(create.inputSchema)).not.toContain('connectionKey')
  })

  it('executes through passthrough with path variables, action id and body connection key', async () => {
    const { calls, fetchImpl } = fakeOne()
    const tools = (await oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': true }, onWarning: quiet })()) as any

    const get = await tools.cal_com_get_event_type.execute({ path: { id: '42' } }, {})
    expect(get).toMatchObject({ ok: true, status: 200, data: { echoed: true } })
    const getCall = calls.find((c) => c.url.pathname === '/v1/passthrough/event-types/42')!
    const headers = getCall.init!.headers as Record<string, string>
    expect(headers['x-one-action-id']).toBe('conn_mod_def::get')
    expect(headers['x-one-connection-key']).toBe('test::cal-com::default::1')
    expect(getCall.init!.body).toBeUndefined()

    await tools.cal_com_create_booking.execute({ body: { start: 'now' } }, {})
    const post = calls.find((c) => c.url.pathname === '/v1/passthrough/v1/cal-com/create-booking')!
    expect(JSON.parse(String(post.init!.body))).toEqual({ start: 'now', connectionKey: 'test::cal-com::default::1' })
  })

  it('applies allow/disallow globs and approval globs', async () => {
    const { fetchImpl } = fakeOne()
    const tools = (await oneTools({
      secret: 'sk_test',
      fetch: fetchImpl,
      onWarning: quiet,
      platforms: { 'cal-com': { allowTools: ['cal_com_*'], disallowTools: ['*_get_*'], requireApproval: ['cal_com_create_*'] } },
    })()) as any
    expect(Object.keys(tools)).toEqual(['cal_com_create_booking'])
    expect(tools.cal_com_create_booking.requireApproval).toBe(true)
  })

  it('switches a large platform to discover tools and guards run_action to enabled platforms', async () => {
    const warnings: string[] = []
    const { fetchImpl } = fakeOne({ actions: 60 })
    const tools = (await oneTools({
      secret: 'sk_test',
      fetch: fetchImpl,
      platforms: { 'cal-com': true },
      onWarning: (w) => warnings.push(w),
    })()) as any
    expect(Object.keys(tools).sort()).toEqual(['one_find_actions', 'one_get_action', 'one_run_action'])
    expect(warnings[0]).toMatch(/60 actions/)

    const found = await tools.one_find_actions.execute({ platform: 'cal-com', query: 'event' }, {})
    expect(found[0]).toMatchObject({ actionId: 'conn_mod_def::get', confidence: 0.92, documentation: expect.stringMatching(/Pass the id/) })
    expect(found[1]).toEqual({
      actionId: 'conn_mod_def::create',
      title: 'Create Booking',
      method: 'POST',
      path: '/v1/cal-com/create-booking',
    })
    const ran = await tools.one_run_action.execute({ actionId: 'conn_mod_def::get', path: { id: '1' } }, {})
    expect(ran.ok).toBe(true)
  })

  it("falls back to catalog search when One's action selector is unavailable", async () => {
    const { fetchImpl } = fakeOne({ actions: 60, findFails: true })
    const tools = (await oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': true }, onWarning: quiet })()) as any
    const found = await tools.one_find_actions.execute({ platform: 'cal-com', query: 'event' }, {})
    expect(found[0]).toEqual({ actionId: 'conn_mod_def::get', title: 'Get Event Type', method: 'GET', path: '/event-types/{{id}}' })
  })

  it("'all' makes every action a typed tool, and ToolSearchProcessor keeps them out of the prompt", async () => {
    const { fetchImpl, calls } = fakeOne({ actions: 60 })
    const resolve = oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': 'all' }, onWarning: quiet })
    const tools = (await resolve()) as any
    expect(Object.keys(tools)).toHaveLength(60)
    expect(calls.filter((c) => c.url.pathname === '/v1/knowledge' && c.url.searchParams.get('connectionPlatform'))).toHaveLength(1)

    const offered: string[][] = []
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
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
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'ok' },
                { type: 'text-end', id: 't' },
                { type: 'finish', finishReason: 'stop', usage },
              ])
                c.enqueue(p)
              c.close()
            },
          }),
        }
      },
    }
    const { Agent } = await import('@mastra/core/agent')
    const { ToolSearchProcessor } = await import('@mastra/core/processors')
    const agent = new Agent({
      id: 'a',
      name: 'a',
      instructions: 'x',
      model: model as any,
      tools: resolve,
      inputProcessors: [new ToolSearchProcessor({ tools: {}, includeResolvedTools: true })],
    })
    await (
      await agent.stream('hi')
    ).text
    expect(offered[0]).not.toContain('cal_com_get_event_type')
    expect(offered[0]!.length).toBeLessThan(5)
  })

  it('turns a platform with no connection into a connect tool that links to One', async () => {
    const { fetchImpl } = fakeOne()
    const tools = (await oneTools({
      secret: 'sk_test_x',
      fetch: fetchImpl,
      appUrl: 'https://app.test',
      platforms: { slack: true },
      onWarning: quiet,
    })()) as any
    expect(Object.keys(tools)).toEqual(['connect_slack'])
    expect(await tools.connect_slack.execute({}, {})).toMatchObject({
      connectRequired: true,
      platform: 'slack',
      url: 'https://app.test/?env=test#open=slack',
    })
  })

  it('skips a platform with no connection when no connect link is available', async () => {
    const warnings: string[] = []
    const { fetchImpl } = fakeOne()
    const tools = await oneTools({
      secret: 'sk_test',
      fetch: fetchImpl,
      platforms: { slack: true },
      connectUrl: () => undefined,
      onWarning: (w) => warnings.push(w),
    })()
    expect(tools).toEqual({})
    expect(warnings[0]).toMatch(/no usable "slack" connection/)
  })

  it('truncates oversized results for the model', async () => {
    const { fetchImpl } = fakeOne()
    const tools = (await oneTools({
      secret: 'sk_test',
      fetch: fetchImpl,
      platforms: { 'cal-com': true },
      maxResultChars: 10,
      onWarning: quiet,
    })()) as any
    const out = tools.cal_com_get_event_type.toModelOutput({ a: 'x'.repeat(50) })
    expect(out).toMatchObject({ type: 'text', value: expect.stringMatching(/truncated/) })
    expect(tools.cal_com_get_event_type.toModelOutput([1])).toEqual({ type: 'json', value: [1] })
    expect(tools.cal_com_get_event_type.toModelOutput('ok')).toEqual({ type: 'text', value: 'ok' })
  })

  it('hands tool results back to the model as typed tool-result parts in a real agent loop', async () => {
    const { fetchImpl } = fakeOne({ actions: 50 })
    const prompts: any[] = []
    const stream = (parts: any[]) =>
      new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(p)
          c.close()
        },
      })
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const model = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('stream only')
      },
      async doStream(opts: any) {
        prompts.push(opts.prompt)
        const step = prompts.length
        const call = (id: string, toolName: string, input: unknown) => ({
          type: 'tool-call',
          toolCallId: id,
          toolName,
          input: JSON.stringify(input),
        })
        const parts =
          step === 1
            ? [call('c1', 'one_find_actions', { platform: 'cal-com', query: 'event' })]
            : step === 2
              ? [call('c2', 'one_get_action', { actionId: 'conn_mod_def::get' })]
              : [
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: 'done' },
                  { type: 'text-end', id: 't' },
                ]
        return {
          stream: stream([
            { type: 'stream-start', warnings: [] },
            ...parts,
            { type: 'finish', finishReason: step < 3 ? 'tool-calls' : 'stop', usage },
          ]),
        }
      },
    }
    const { Agent } = await import('@mastra/core/agent')
    const agent = new Agent({
      id: 'a',
      name: 'a',
      instructions: 'x',
      model: model as any,
      tools: oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': true }, onWarning: quiet }),
    })
    const res = await agent.stream('find event actions')
    expect(await res.text).toBe('done')
    // Every tool result in every later prompt must be a typed part; OpenAI rejects an untyped one
    // ("Missing required parameter: 'input[n].output'").
    const results = prompts
      .slice(1)
      .flatMap((prompt) => prompt.flatMap((m: any) => (m.role === 'tool' ? m.content : [])).filter((p: any) => p.type === 'tool-result'))
    expect(results).toHaveLength(3)
    for (const r of results) expect(['json', 'text']).toContain(r.output?.type)
    expect(results.at(-1).output.value).toMatchObject({ title: 'Get Event Type' })
  })
})
