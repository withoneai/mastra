import { describe, expect, it } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { OneConnectLike } from '../src/backend.js'
import { oneTools } from '../src/tools.js'

class FakeConnectError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function fakeConnect(opts: { grants: Record<string, string[]>; runError?: string; blocked?: boolean }) {
  const runs: Array<{ userId: string; input: any }> = []
  const actions = [
    { _id: 'conn_mod_def::send', title: 'Send Email', method: 'POST', path: '/gmail/send', tags: [] },
    { _id: 'conn_mod_def::list', title: 'List Messages', method: 'GET', path: '/gmail/messages', tags: [] },
  ]
  const connect: OneConnectLike = {
    listConnections: async (userId) => {
      const platforms = opts.grants[userId]
      if (!platforms) throw new FakeConnectError('not_connected')
      return platforms.map((p) => ({ key: `live::${p}::default::${userId}`, platform: p }))
    },
    listActions: async () => actions,
    searchActions: async () => actions,
    getActionKnowledge: async (_u, id) => ({
      ...actions.find((a) => a._id === id)!,
      platform: 'gmail',
      knowledge: '## Description\n\nDoes the thing.',
      ioSchema: { inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { to: { type: 'string' } } } } } },
    }),
    runAction: async (userId, input) => {
      runs.push({ userId, input })
      if (opts.runError) throw new FakeConnectError(opts.runError)
      return opts.blocked
        ? { status: 403, ok: false, blockedByGrant: true, refusal: 'grant', data: null }
        : { status: 200, ok: true, blockedByGrant: false, refusal: null, data: { id: 'm1' } }
    },
  }
  return { connect, runs }
}

const ctx = (userId?: string) => ({ requestContext: new RequestContext(userId ? [['userId', userId]] : []) })
const userId = ({ requestContext }: any) => requestContext?.get('userId')
const connectUrl = ({ platform, userId }: { platform: string; userId?: string }) => `https://app.example/connect/${platform}?u=${userId}`

describe('oneTools with One Connect', () => {
  it('builds each user their own tools and runs actions with their grant', async () => {
    const { connect, runs } = fakeConnect({ grants: { alice: ['gmail'], bob: [] } })
    const resolve = oneTools({ connect, userId, connectUrl, platforms: { gmail: true } })

    const alice = (await resolve(ctx('alice'))) as any
    expect(Object.keys(alice)).toEqual(['gmail_send_email', 'gmail_list_messages'])
    await alice.gmail_send_email.execute({ body: { to: 'x@y.z' } }, {})
    expect(runs[0]).toEqual({
      userId: 'alice',
      input: expect.objectContaining({ connectionKey: 'live::gmail::default::alice', actionId: 'conn_mod_def::send', body: { to: 'x@y.z' } }),
    })

    const bob = (await resolve(ctx('bob'))) as any
    expect(Object.keys(bob)).toEqual(['connect_gmail'])
    expect((await bob.connect_gmail.execute({}, {})).url).toBe('https://app.example/connect/gmail?u=bob')
  })

  it('treats a user who never connected like one missing every platform', async () => {
    const { connect } = fakeConnect({ grants: {} })
    const tools = await oneTools({ connect, userId, connectUrl, platforms: { gmail: true, slack: true } })(ctx('carol'))
    expect(Object.keys(tools)).toEqual(['connect_gmail', 'connect_slack'])
  })

  it('returns a reconnect link when the grant was revoked mid-session', async () => {
    const { connect } = fakeConnect({ grants: { alice: ['gmail'] }, runError: 'reconnect_required' })
    const tools = (await oneTools({ connect, userId, connectUrl, platforms: { gmail: true } })(ctx('alice'))) as any
    const res = await tools.gmail_send_email.execute({ body: { to: 'x' } }, {})
    expect(res).toMatchObject({ ok: false, connectRequired: true, url: 'https://app.example/connect/gmail?u=alice' })
  })

  it('surfaces a call outside the grant without retrying', async () => {
    const { connect, runs } = fakeConnect({ grants: { alice: ['gmail'] }, blocked: true })
    const tools = (await oneTools({ connect, userId, connectUrl, platforms: { gmail: true } })(ctx('alice'))) as any
    expect(await tools.gmail_send_email.execute({ body: { to: 'x' } }, {})).toMatchObject({ ok: false, status: 403, blockedByGrant: true, refusal: 'grant' })
    expect(runs).toHaveLength(1)
  })

  it('exposes no One tools to a request without a user', async () => {
    const warnings: string[] = []
    const { connect } = fakeConnect({ grants: { alice: ['gmail'] } })
    const tools = await oneTools({ connect, userId, platforms: { gmail: true }, onWarning: (w) => warnings.push(w) })(ctx())
    expect(tools).toEqual({})
    expect(warnings[0]).toMatch(/no userId/)
  })

  it('keeps discover mode on enabled platforms for connect users', async () => {
    const { connect, runs } = fakeConnect({ grants: { alice: ['gmail'] } })
    const tools = (await oneTools({ connect, userId, connectUrl, platforms: { gmail: 'discover' } })(ctx('alice'))) as any
    expect(Object.keys(tools).sort()).toEqual(['one_find_actions', 'one_get_action', 'one_run_action'])
    const ran = await tools.one_run_action.execute({ actionId: 'conn_mod_def::list' }, {})
    expect(ran.ok).toBe(true)
    expect(runs[0]!.input.connectionKey).toBe('live::gmail::default::alice')
  })

  it('requires a userId resolver with connect', () => {
    const { connect } = fakeConnect({ grants: {} })
    expect(() => oneTools({ connect, platforms: {} })).toThrow(/userId/)
  })
})
