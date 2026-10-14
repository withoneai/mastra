import { describe, expect, it } from 'vitest'
import { oneTools } from '../src/tools.js'

interface Call {
  url: URL
  init?: RequestInit
}

function fakeOne(opts: { actions?: number } = {}) {
  const calls: Call[] = []
  const actions = Array.from({ length: opts.actions ?? 2 }, (_, i) =>
    i === 0
      ? { systemId: 'conn_mod_def::get', title: 'Get Event Type', key: 'k0', method: 'GET', path: '/event-types/{{id}}', tags: [] }
      : i === 1
        ? { systemId: 'conn_mod_def::create', title: 'Create Booking', key: 'k1', method: 'POST', path: '/v1/cal-com/create-booking', tags: ['custom'] }
        : { systemId: `conn_mod_def::a${i}`, title: `Action ${i}`, key: `k${i}`, method: 'GET', path: `/a/${i}`, tags: [] },
  )
  const knowledge: Record<string, unknown> = {
    'conn_mod_def::get': {
      _id: 'conn_mod_def::get', title: 'Get Event Type', method: 'GET', path: '/event-types/{{id}}', tags: [], connectionPlatform: 'cal-com',
      ioSchema: { inputSchema: { type: 'object', description: 'Fetch one event type.', properties: { path: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }, required: ['path'] } },
    },
    'conn_mod_def::create': {
      _id: 'conn_mod_def::create', title: 'Create Booking', method: 'POST', path: '/v1/cal-com/create-booking', tags: ['custom'], connectionPlatform: 'cal-com',
      knowledge: '# Create Booking\n\n## Description\n\nBooks a slot.\n\n## Other\n\nx',
      ioSchema: { inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { connectionKey: { type: 'string' }, start: { type: 'string' } }, required: ['connectionKey', 'start'] } }, required: ['body'] } },
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
    if (url.pathname.startsWith('/v1/available-actions/')) return json({ rows: actions, pages: 1, total: actions.length })
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
    const tools = (await oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': true }, onWarning: (w) => warnings.push(w) })()) as any
    expect(Object.keys(tools).sort()).toEqual(['one_find_actions', 'one_get_action', 'one_run_action'])
    expect(warnings[0]).toMatch(/60 actions/)

    const found = await tools.one_find_actions.execute({ platform: 'cal-com', query: 'event' }, {})
    expect(found[0].actionId).toBe('conn_mod_def::get')
    const ran = await tools.one_run_action.execute({ actionId: 'conn_mod_def::get', path: { id: '1' } }, {})
    expect(ran.ok).toBe(true)
  })

  it('turns a platform with no connection into a connect tool that links to One', async () => {
    const { fetchImpl } = fakeOne()
    const tools = (await oneTools({ secret: 'sk_test_x', fetch: fetchImpl, appUrl: 'https://app.test', platforms: { slack: true }, onWarning: quiet })()) as any
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
    const tools = await oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { slack: true }, connectUrl: () => undefined, onWarning: (w) => warnings.push(w) })()
    expect(tools).toEqual({})
    expect(warnings[0]).toMatch(/no usable "slack" connection/)
  })

  it('truncates oversized results for the model', async () => {
    const { fetchImpl } = fakeOne()
    const tools = (await oneTools({ secret: 'sk_test', fetch: fetchImpl, platforms: { 'cal-com': true }, maxResultChars: 10, onWarning: quiet })()) as any
    const out = tools.cal_com_get_event_type.toModelOutput({ a: 'x'.repeat(50) })
    expect(out).toMatch(/truncated/)
  })
})
