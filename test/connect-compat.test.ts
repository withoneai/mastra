import { describe, expect, it } from 'vitest'
import { createOneConnect, OneConnectError } from '@withone/connect/server'
import type { OneConnectLike } from '../src/backend.js'
import { oneTools } from '../src/tools.js'

describe('@withone/connect compatibility', () => {
  const users = new Map<string, string>()
  const real = createOneConnect({
    clientId: 'client',
    clientSecret: 'one_secret_x',
    redirectUri: 'http://localhost/api/one/callback',
    connectKey: 'sk_test_connectkey',
    userStore: {
      saveUser: async (id, ref) => void users.set(id, ref),
      loadUser: async (id) => users.get(id) ?? null,
      clearUser: async (id) => void users.delete(id),
    },
  })

  it('the real client satisfies the interface oneTools needs', () => {
    const asLike: OneConnectLike = real
    expect(asLike).toBeDefined()
  })

  it('a user who never connected gets connect tools, not an error', async () => {
    await expect(real.listConnections('nobody')).rejects.toBeInstanceOf(OneConnectError)
    const tools = (await oneTools({
      connect: real,
      userId: () => 'nobody',
      connectUrl: ({ platform }) => `/api/one/authorize?connector=${platform}`,
      platforms: { gmail: true, slack: true },
    })()) as any
    expect(Object.keys(tools)).toEqual(['connect_gmail', 'connect_slack'])
    expect((await tools.connect_gmail.execute({}, {})).url).toBe('/api/one/authorize?connector=gmail')
  })
})
