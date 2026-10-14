import { describe, expect, it } from 'vitest'
import { OneToolProvider } from '../src/provider.js'

interface Conn {
  id: string
  key: string
  platform: string
  state: string
  active: boolean
  tags: string[]
}

function fakeOne() {
  const connections: Conn[] = [
    { id: 'u1', key: 'test::linear::default::a', platform: 'linear', state: 'operational', active: true, tags: [] },
    { id: 'u2', key: 'test::linear::default::b', platform: 'linear', state: 'failed', active: true, tags: [] },
  ]
  const actions = [
    { systemId: 'conn_mod_def::list', title: 'List Issues', key: 'k1', method: 'POST', path: '/graphql', tags: [] },
    { systemId: 'conn_mod_def::create', title: 'Create Issue', key: 'k2', method: 'POST', path: '/graphql', tags: [] },
  ]
  const requests: Array<{ method: string; url: URL; body?: string }> = []

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    requests.push({ method, url, body: init?.body as string | undefined })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const p = url.pathname

    if (p === '/v1/available-connectors') {
      return json({ rows: [{ platform: 'linear', name: 'Linear', title: 'Linear', image: 'l.svg', active: true }, { platform: 'old', name: 'Old', active: false }], pages: 1 })
    }
    if (p === '/v1/users/whoami') return json({ organization: { id: 'org_1' }, project: null })
    if (p === '/v1/vault/connections' && method === 'GET') {
      const platform = url.searchParams.get('platform')
      const keys = url.searchParams.get('key')?.split(',')
      const tags = url.searchParams.get('tags')?.split(',')
      const rows = connections.filter(
        (c) => (!platform || c.platform === platform) && (!keys || keys.includes(c.key)) && (!tags || tags.every((t) => c.tags.includes(t))),
      )
      return json({ rows, pages: 1 })
    }
    if (p.startsWith('/v1/vault/connections/') && method === 'PATCH') {
      const conn = connections.find((c) => c.id === p.split('/').pop())!
      conn.tags = JSON.parse(String(init!.body)).tags
      return json({})
    }
    if (p.startsWith('/v1/vault/connections/') && method === 'DELETE') {
      const i = connections.findIndex((c) => c.id === p.split('/').pop())
      if (i >= 0) connections.splice(i, 1)
      return json({})
    }
    if (p === '/v1/available-actions/search/linear') return json([actions[1], actions[0]])
    if (p === '/v1/available-actions/linear') return json({ rows: actions, pages: 1, total: actions.length })
    if (p === '/v1/knowledge') {
      const a = actions.find((x) => x.systemId === url.searchParams.get('_id'))!
      return json({ rows: [{ ...a, _id: a.systemId, ioSchema: { inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }, required: ['body'] } } }] })
    }
    if (p.startsWith('/v1/passthrough/')) return json({ data: { ok: 1 } })
    return json({ error: p }, 404)
  }) as typeof fetch

  return { connections, requests, fetchImpl }
}

const make = (fake: ReturnType<typeof fakeOne>, extra = {}) =>
  new OneToolProvider({ secret: 'sk_test_x', fetch: fake.fetchImpl, appUrl: 'https://app.test', ...extra })

describe('OneToolProvider', () => {
  it('lists active One platforms as toolkits and actions as tools', async () => {
    const provider = make(fakeOne())
    expect((await provider.listToolkitsVNext()).data).toEqual([{ slug: 'linear', name: 'Linear', description: undefined, icon: 'l.svg' }])
    const tools = await provider.listToolsVNext({ toolkit: 'linear' })
    expect(tools.data.map((t) => t.slug)).toEqual(['linear_list_issues', 'linear_create_issue'])
    expect(tools.pagination.hasMore).toBe(false)
  })

  it('keeps search results in relevance order', async () => {
    const provider = make(fakeOne())
    const tools = await provider.listToolsVNext({ toolkit: 'linear', search: 'issue' })
    expect(tools.data.map((t) => t.slug)).toEqual(['linear_create_issue', 'linear_list_issues'])
  })

  it('treats a search with no toolkit as an app-name search', async () => {
    const tools = await make(fakeOne()).listToolsVNext({ search: 'Lin' })
    expect(tools.data.map((t) => t.slug)).toEqual(['linear_list_issues', 'linear_create_issue'])
  })

  it('returns nothing for an unscoped tool listing rather than walking 900+ platforms', async () => {
    const tools = await make(fakeOne()).listToolsVNext({})
    expect(tools.data).toEqual([])
  })

  it('maps connection state and checks status per key', async () => {
    const provider = make(fakeOne())
    const conns = await provider.listConnections({ toolkit: 'linear' })
    expect(conns.items).toEqual([
      { connectionId: 'test::linear::default::a', status: 'active' },
      { connectionId: 'test::linear::default::b', status: 'failed' },
    ])
    expect(
      await provider.getConnectionStatus({
        items: [
          { connectionId: 'test::linear::default::a', toolkit: 'linear' },
          { connectionId: 'test::linear::default::b', toolkit: 'linear' },
        ],
      }),
    ).toEqual({ 'test::linear::default::a': { connected: true }, 'test::linear::default::b': { connected: false } })
  })

  it('resolves pinned tools bound to the pinned connection, with approval globs and description overrides', async () => {
    const fake = fakeOne()
    const provider = make(fake, { requireApproval: ['*_create_*'] })
    const tools = (await provider.resolveToolsVNext({
      toolSlugs: ['linear_list_issues', 'linear_create_issue', 'linear_missing'],
      toolMeta: { linear_list_issues: { toolkit: 'linear', description: 'Custom' } },
      connectionId: 'test::linear::default::a',
      toolkit: 'linear',
    })) as any
    expect(Object.keys(tools)).toEqual(['linear_list_issues', 'linear_create_issue'])
    expect(tools.linear_list_issues.description).toBe('Custom')
    expect(tools.linear_create_issue.requireApproval).toBe(true)

    await tools.linear_list_issues.execute({ body: { query: '{ x }' } }, {})
    const call = fake.requests.find((r) => r.url.pathname === '/v1/passthrough/graphql')!
    expect(call.method).toBe('POST')
  })

  it('resolves an agent saved without a pinned connection through the legacy resolveTools path', async () => {
    const fake = fakeOne()
    const tools = (await make(fake).resolveTools(['linear_list_issues'], { linear_list_issues: { description: 'POST /graphql' } })) as any
    expect(Object.keys(tools)).toEqual(['linear_list_issues'])
    await tools.linear_list_issues.execute({ body: { query: '{ x }' } }, {})
    const call = fake.requests.find((r) => r.url.pathname === '/v1/passthrough/graphql')!
    expect(call).toBeDefined()
  })

  it('skips, rather than fails, unpinned tools for a platform with no operational connection', async () => {
    const fake = fakeOne()
    fake.connections.splice(0, 1)
    expect(await make(fake).resolveTools(['linear_list_issues'])).toEqual({})
  })

  it("pauses only actions that change data with requireApproval: 'writes'", async () => {
    const tools = (await make(fakeOne(), { requireApproval: 'writes' }).resolveToolsVNext({
      toolSlugs: ['linear_list_issues', 'linear_create_issue'],
      toolMeta: {},
      connectionId: 'test::linear::default::a',
      toolkit: 'linear',
    })) as any
    expect(tools.linear_list_issues.requireApproval).toBe(false)
    expect(tools.linear_create_issue.requireApproval).toBe(true)
  })

  it('refuses to resolve against a failed connection', async () => {
    const provider = make(fakeOne())
    await expect(
      provider.resolveToolsVNext({ toolSlugs: ['linear_list_issues'], toolMeta: {}, connectionId: 'test::linear::default::b', toolkit: 'linear' }),
    ).rejects.toThrow(/no operational "linear" connection/)
  })

  it('runs the connect flow: dashboard url, pending, then completed and tagged so it survives a restart', async () => {
    const fake = fakeOne()
    const provider = make(fake)
    const { url, authId } = await provider.authorize({ toolkit: 'linear', connectionId: 'default' })
    expect(url).toBe('https://app.test/?env=test&orgId=org_1#open=linear')
    expect(await provider.getAuthStatus(authId)).toBe('pending')

    fake.connections.push({ id: 'u3', key: 'test::linear::default::new', platform: 'linear', state: 'operational', active: true, tags: ['team'] })
    expect(await provider.getAuthStatus(authId)).toBe('completed')
    expect(fake.connections.at(-1)!.tags).toEqual(['team', authId])

    // A fresh provider (e.g. after a restart) resolves the auth id through the tag.
    const restarted = make(fake)
    expect(await restarted.getAuthStatus(authId)).toBe('completed')
    const tools = (await restarted.resolveToolsVNext({ toolSlugs: ['linear_list_issues'], toolMeta: {}, connectionId: authId, toolkit: 'linear' })) as any
    await tools.linear_list_issues.execute({ body: { query: '{ x }' } }, {})
    const call = fake.requests.filter((r) => r.url.pathname === '/v1/passthrough/graphql').at(-1)!
    expect(call).toBeDefined()
  })

  it('reports a failed flow and unknown auth ids', async () => {
    const fake = fakeOne()
    const provider = make(fake)
    const { authId } = await provider.authorize({ toolkit: 'linear', connectionId: 'default' })
    fake.connections.push({ id: 'u4', key: 'test::linear::default::bad', platform: 'linear', state: 'failed', active: true, tags: [] })
    expect(await provider.getAuthStatus(authId)).toBe('failed')
    expect(await provider.getAuthStatus('oneauth_nope')).toBe('failed')
  })

  it('revokes by connection key', async () => {
    const fake = fakeOne()
    await make(fake).revokeConnection('test::linear::default::a')
    expect(fake.connections.map((c) => c.key)).toEqual(['test::linear::default::b'])
  })

  it('finds the platform of a slug when no toolkit is given', async () => {
    const provider = make(fakeOne())
    const schema = await provider.getToolSchema('linear_list_issues')
    expect(schema).toMatchObject({ type: 'object', properties: { body: { properties: { query: { type: 'string' } } } } })
  })
})
