import { describe, expect, it } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { parseUserReference } from '../src/backend.js'
import { oneTools } from '../src/tools.js'

const ALICE = `cu_${'a'.repeat(64)}`
const BOB = `cu_${'b'.repeat(64)}`

/** One's API as a Connect key sees it: the grant decides what each user reaches. */
function fakeOne(opts: { grants: Record<string, string[]>; revoked?: Set<string>; outsideGrant?: string[] }) {
  const calls: Array<{ path: string; headers: Record<string, string> }> = []
  const actions = [
    { _id: 'conn_mod_def::send', title: 'Send Email', method: 'POST', path: '/gmail/send', tags: [], connectionPlatform: 'gmail' },
    { _id: 'conn_mod_def::list', title: 'List Messages', method: 'GET', path: '/gmail/messages', tags: [], connectionPlatform: 'gmail' },
  ].map((a) => ({ ...a, knowledge: '## Description\n\nDoes the thing.', ioSchema: { inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { to: { type: 'string' } } } } } } }))

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ path: url.pathname, headers })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const bare = (status: number, text: string) => new Response(`${status} ${text}`, { status })

    if (headers['x-one-secret'] !== 'sk_live_ck') return bare(401, 'Unauthorized')
    const user = headers['x-one-connect-user-id']!
    const grant = opts.grants[user]
    if (!grant || opts.revoked?.has(user)) return bare(403, 'Forbidden')

    if (url.pathname === '/v1/connections/reachable') return json({ rows: grant.map((p) => ({ key: `live::${p}::${user.slice(0, 6)}`, platform: p })) })
    if (url.pathname === '/v1/knowledge') {
      const id = url.searchParams.get('_id')
      return json({ rows: id ? actions.filter((a) => a._id === id) : actions, pages: 1 })
    }
    if (url.pathname.startsWith('/v1/available-actions/search/')) return json(actions)
    if (url.pathname.startsWith('/v1/passthrough/')) {
      if (opts.outsideGrant?.includes(url.pathname)) return bare(403, 'Forbidden')
      return json({ id: 'm1' })
    }
    return json({ error: url.pathname }, 404)
  }) as typeof fetch

  return { calls, fetchImpl }
}

const references: Record<string, string> = { alice: `${ALICE};org=org_1;project=prj_1`, bob: BOB }

const make = (fake: ReturnType<typeof fakeOne>) =>
  oneTools({
    connect: { connectKey: 'sk_live_ck', loadUser: (id) => references[id] ?? null, baseUrl: 'https://one.test' },
    userId: ({ requestContext }) => requestContext?.get('userId'),
    connectUrl: ({ platform, userId }) => `/one/authorize?as=${userId}#one_connector=${platform}`,
    platforms: { gmail: true },
    fetch: fake.fetchImpl,
    onWarning: () => {},
  })

const as = (userId: string) => ({ requestContext: new RequestContext([['userId', userId]]) })

describe('One Connect with a connect key (no @withone/connect)', () => {
  it("acts with each user's own grant and sends the space they granted from", async () => {
    const fake = fakeOne({ grants: { [ALICE]: ['gmail'] } })
    const resolve = make(fake)

    const alice = (await resolve(as('alice'))) as any
    expect(Object.keys(alice).sort()).toEqual(['gmail_list_messages', 'gmail_send_email'])
    expect(await alice.gmail_send_email.execute({ body: { to: 'x' } }, {})).toMatchObject({ ok: true, data: { id: 'm1' } })
    const run = fake.calls.find((c) => c.path === '/v1/passthrough/gmail/send')!
    expect(run.headers).toMatchObject({
      'x-one-secret': 'sk_live_ck',
      'x-one-connect-user-id': ALICE,
      'x-one-organization-id': 'org_1',
      'x-one-project-id': 'prj_1',
      'x-one-connection-key': `live::gmail::${ALICE.slice(0, 6)}`,
    })

    // Bob has no grant for Gmail, and never sees Alice's.
    expect(Object.keys(await resolve(as('bob')))).toEqual(['connect_gmail'])
    // Carol never connected at all.
    expect(Object.keys(await resolve(as('carol')))).toEqual(['connect_gmail'])
  })

  it('reports a call outside the grant as blockedByGrant while the consent stands', async () => {
    const fake = fakeOne({ grants: { [ALICE]: ['gmail'] }, outsideGrant: ['/v1/passthrough/gmail/send'] })
    const tools = (await make(fake)(as('alice'))) as any
    expect(await tools.gmail_send_email.execute({ body: {} }, {})).toMatchObject({ ok: false, status: 403, blockedByGrant: true, refusal: 'grant' })
  })

  it('returns a reconnect link once the consent is revoked mid-session', async () => {
    const revoked = new Set<string>()
    const fake = fakeOne({ grants: { [ALICE]: ['gmail'] }, revoked })
    const tools = (await make(fake)(as('alice'))) as any
    revoked.add(ALICE)
    expect(await tools.gmail_list_messages.execute({}, {})).toMatchObject({
      connectRequired: true,
      url: '/one/authorize?as=alice#one_connector=gmail',
    })
  })

  it('parses the reference @withone/connect stores', () => {
    expect(parseUserReference(`${ALICE};org=o;project=p`)).toEqual({ connectUserId: ALICE, organizationId: 'o', projectId: 'p' })
    expect(parseUserReference(BOB)).toEqual({ connectUserId: BOB })
    expect(parseUserReference('not-a-ref')).toBeNull()
  })
})
