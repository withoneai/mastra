import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApiRoute } from '@mastra/core/server'
import { createOneConnect } from '@withone/connect/server'
import { createOneConnectRoutes } from '@withone/connect/next'

// Per-user mode needs a One Connect app (Dashboard → Developers → Connect). Without its
// credentials the example runs without it.
const configured = Boolean(process.env.ONE_CLIENT_ID && process.env.ONE_CLIENT_SECRET && process.env.ONE_CONNECT_KEY)

// A demo user store: one JSON file mapping your app's user ids to their One Connect reference.
// A real app keeps this column on its users table.
const STORE = process.env.ONE_CONNECT_STORE ?? join(tmpdir(), 'one-mastra-connect-users.json')
const readStore = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}
const writeStore = (users: Record<string, string>) => writeFileSync(STORE, JSON.stringify(users, null, 2))

const REDIRECT_URI = process.env.ONE_REDIRECT_URI ?? 'http://localhost:4111/one/callback'

/** What `oneTools` needs for per-user mode: the connect key, and each user's stored One reference. */
export const oneConnectKey = configured
  ? { connectKey: process.env.ONE_CONNECT_KEY!, loadUser: async (userId: string) => readStore()[userId] ?? null }
  : undefined

export const oneConnect = configured
  ? createOneConnect({
      clientId: process.env.ONE_CLIENT_ID!,
      clientSecret: process.env.ONE_CLIENT_SECRET!,
      redirectUri: REDIRECT_URI,
      permissionSet: process.env.ONE_PERMISSION_SET,
      connectKey: process.env.ONE_CONNECT_KEY!,
      userStore: {
        saveUser: async (userId, reference) => writeStore({ ...readStore(), [userId]: reference }),
        loadUser: async (userId) => readStore()[userId] ?? null,
        clearUser: async (userId) => {
          const { [userId]: _, ...rest } = readStore()
          writeStore(rest)
        },
      },
    })
  : undefined

// The demo has no sign-in, so "who clicked Connect" is `?as=<user>` on the authorize link,
// remembered in a cookie for the callback. A real app reads its own session here.
const DEMO_USER_COOKIE = 'one_demo_user'
const demoUser = (request: Request): string | null =>
  new URL(request.url).searchParams.get('as') ??
  request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${DEMO_USER_COOKIE}=([^;]+)`))?.[1] ??
  null

export const authorizeUrl = (userId: string, platform?: string) =>
  `${new URL(REDIRECT_URI).origin}/one/authorize?as=${encodeURIComponent(userId)}${platform ? `#one_connector=${platform}` : ''}`

export const oneConnectRoutes = oneConnect
  ? (() => {
      const routes = createOneConnectRoutes(oneConnect, {
        identifyUser: demoUser,
        onComplete: ({ userId, result }) => console.log(`[one-connect] ${userId}: ${result.outcome}${result.message ? ` (${result.message})` : ''}`),
      })
      const handle = async (request: Request, rememberUser: boolean) => {
        const res = await routes.GET(request)
        const user = rememberUser ? new URL(request.url).searchParams.get('as') : null
        if (!user) return res
        const headers = new Headers(res.headers)
        headers.append('set-cookie', `${DEMO_USER_COOKIE}=${encodeURIComponent(user)}; Path=/one; HttpOnly; SameSite=Lax`)
        return new Response(res.body, { status: res.status, headers })
      }
      return [
        registerApiRoute('/one/authorize', { method: 'GET', requiresAuth: false, handler: (c) => handle(c.req.raw, true) }),
        registerApiRoute('/one/callback', { method: 'GET', requiresAuth: false, handler: (c) => handle(c.req.raw, false) }),
      ]
    })()
  : []
