import { OneApiError, type ExecuteResult, type FoundActions, type OneAction, type OneActionKnowledge, type OneClient, type RequestScope } from './client.js'

/** A connection the current caller can use. */
export interface BackendConnection {
  key: string
  platform: string
  usable: boolean
  tags?: string[]
}

export interface RunInput {
  action: Pick<OneAction, 'systemId' | 'method' | 'path' | 'tags'>
  connectionKey: string
  pathVariables?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

export interface RunResult extends ExecuteResult {
  /** One Connect: the call is outside what the user granted. */
  blockedByGrant?: boolean
  refusal?: string | null
  /** The user has to connect (or reconnect) before this can run. */
  connectRequired?: boolean
}

/** How tools reach One for one caller: an account secret, or one end user's One Connect grant. */
export interface Backend {
  /** Cache partition for per-caller data. */
  readonly scope: string
  connections(platform: string): Promise<BackendConnection[]>
  countActions(platform: string): Promise<number>
  listActions(platform: string): Promise<OneAction[]>
  searchActions(platform: string, query: string, limit: number): Promise<OneAction[]>
  /** One's action selector (picks the action and returns its docs). Absent for One Connect, which only has search. */
  find?(platform: string, intent: string): Promise<FoundActions | undefined>
  knowledge(actionId: string): Promise<OneActionKnowledge>
  run(input: RunInput): Promise<RunResult>
}

export function secretBackend(client: OneClient): Backend {
  return {
    scope: 'secret',
    connections: async (platform) =>
      (await client.listConnections({ platform })).filter((c) => c.platform === platform).map((c) => ({
        key: c.key,
        platform: c.platform,
        usable: c.state === 'operational' && c.active !== false,
        tags: c.tags,
      })),
    countActions: (platform) => client.countActions(platform),
    listActions: (platform) => client.listActions(platform),
    searchActions: (platform, query, limit) => client.searchActions(platform, query, limit),
    find: async (platform, intent) => (await client.findActions([{ platform, intent }]))[0],
    knowledge: (id) => client.getKnowledge(id),
    run: (input) => client.execute(input),
  }
}

/**
 * The subset of `@withone/connect/server`'s client this package uses, so
 * `@withone/connect` stays an optional peer.
 */
export interface OneConnectLike {
  listConnections(userId: string): Promise<Array<{ key: string; platform: string }>>
  listActions(userId: string, platform: string): Promise<Array<{ _id: string; title: string; method: string; path: string; tags?: string[] }>>
  searchActions(
    userId: string,
    platform: string,
    query: string,
    options?: { limit?: number },
  ): Promise<Array<{ _id: string; title: string; method: string; path: string; tags?: string[] }>>
  getActionKnowledge(userId: string, actionId: string): Promise<{ _id: string; title: string; method: string; path: string; tags?: string[]; knowledge?: string; ioSchema?: unknown }>
  runAction(
    userId: string,
    input: {
      connectionKey: string
      actionId: string
      method?: string
      path?: string
      pathParams?: Record<string, string | number | boolean>
      query?: Record<string, string | string[]>
      body?: unknown
    },
  ): Promise<{ status: number; ok: boolean; blockedByGrant: boolean; refusal: string | null; data: unknown }>
}

const NEEDS_CONNECT = new Set(['not_connected', 'reconnect_required', 'refresh_failed'])

/** True for a `OneConnectError` that means the user has to connect again. */
export function isConnectRequired(err: unknown): boolean {
  return typeof err === 'object' && err !== null && NEEDS_CONNECT.has((err as { code?: string }).code ?? '')
}

export function connectBackend(connect: OneConnectLike, userId: string): Backend {
  const toAction = (a: { _id: string; title: string; method: string; path: string; tags?: string[] }): OneAction => ({
    systemId: a._id,
    title: a.title,
    key: a._id,
    method: a.method,
    path: a.path,
    tags: a.tags,
  })
  return {
    scope: `connect:${userId}`,
    connections: async (platform) => {
      try {
        return (await connect.listConnections(userId))
          .filter((c) => c.platform === platform)
          .map((c) => ({ key: c.key, platform: c.platform, usable: true }))
      } catch (err) {
        if (isConnectRequired(err)) return []
        throw err
      }
    },
    countActions: async (platform) => (await connect.listActions(userId, platform)).length,
    listActions: async (platform) => (await connect.listActions(userId, platform)).map(toAction),
    searchActions: async (platform, query, limit) => (await connect.searchActions(userId, platform, query, { limit })).map(toAction),
    knowledge: async (id) => {
      const k = await connect.getActionKnowledge(userId, id)
      return { ...k, ioSchema: k.ioSchema as OneActionKnowledge['ioSchema'] }
    },
    run: async (input) => {
      try {
        const res = await connect.runAction(userId, {
          connectionKey: input.connectionKey,
          actionId: input.action.systemId,
          method: input.action.method,
          path: input.action.path,
          pathParams: input.pathVariables as Record<string, string | number | boolean> | undefined,
          query: input.query as Record<string, string | string[]> | undefined,
          body: input.body,
        })
        return { ok: res.ok, status: res.status, data: res.data, blockedByGrant: res.blockedByGrant, refusal: res.refusal }
      } catch (err) {
        if (isConnectRequired(err)) return { ok: false, status: 401, data: null, connectRequired: true }
        throw err
      }
    },
  }
}

/**
 * One Connect in key mode, without `@withone/connect`: the app's connect key plus the reference
 * `@withone/connect` stored for each user (`cu_…[;org=…][;project=…]`). `loadUser` is the same
 * function you give `createOneConnect`'s `userStore`.
 */
export interface OneConnectKey {
  connectKey: string
  loadUser: (userId: string) => Promise<string | null> | string | null
  /** Connect keys work on production only. Default `https://api.withone.ai`. */
  baseUrl?: string
}

export function isConnectKey(connect: unknown): connect is OneConnectKey {
  return typeof connect === 'object' && connect !== null && typeof (connect as OneConnectKey).connectKey === 'string'
}

/** Reads `cu_<id>[;org=<id>][;project=<id>]`, the per-user value `@withone/connect` stores. */
export function parseUserReference(reference: string): RequestScope | null {
  const [connectUserId = '', ...rest] = reference.trim().split(';')
  if (!/^cu_[0-9a-f]+$/i.test(connectUserId)) return null
  const scope: RequestScope = { connectUserId }
  for (const part of rest) {
    if (part.startsWith('org=')) scope.organizationId = part.slice(4)
    else if (part.startsWith('project=')) scope.projectId = part.slice(8)
  }
  return scope
}

/** One answers a revoked consent, and a call outside the grant, with the same bare text. */
const isBare = (res: { status: number; data: unknown }, text: string) =>
  typeof res.data === 'string' && res.data.trim() === `${res.status} ${text}`

/** A refusal One itself wrote (it carries a correlation id), as opposed to the provider's own error. */
function oneRefusal(res: ExecuteResult): string | null {
  if (res.ok || typeof res.data !== 'object' || res.data === null || !('correlationId' in res.data)) return null
  return res.status === 403 ? 'grant' : res.status === 402 ? 'plan_limit' : res.status === 429 ? 'rate_limit' : 'one_error'
}

export function connectKeyBackend(client: OneClient, scope: RequestScope | null, userId: string): Backend {
  const noGrant = (err: unknown) => err instanceof OneApiError && err.status === 403
  // Distinguishes "this call is outside the grant" from "the consent is gone": the grant's reach still answers in the first case.
  const consentStands = async () => {
    try {
      await client.reachableConnections(scope!, 1)
      return true
    } catch (err) {
      if (noGrant(err)) return false
      throw err
    }
  }
  const toAction = (a: OneActionKnowledge | OneAction): OneAction => {
    const id = (a as OneActionKnowledge)._id ?? (a as OneAction).systemId
    return { systemId: id, title: a.title, key: id, method: a.method, path: a.path, tags: a.tags }
  }
  return {
    scope: `connect:${userId}`,
    connections: async (platform) => {
      if (!scope) return []
      try {
        return (await client.reachableConnections(scope))
          .filter((c) => c.platform === platform)
          .map((c) => ({ key: c.key, platform: c.platform, usable: true }))
      } catch (err) {
        if (noGrant(err)) return []
        throw err
      }
    },
    countActions: async (platform) => (await client.listKnowledge(platform, scope ?? undefined)).length,
    listActions: async (platform) => (await client.listKnowledge(platform, scope ?? undefined)).map(toAction),
    searchActions: async (platform, query, limit) => (await client.searchActions(platform, query, limit, scope ?? undefined)).map(toAction),
    knowledge: (id) => client.getKnowledge(id, scope ?? undefined),
    run: async (input) => {
      if (!scope) return { ok: false, status: 401, data: null, connectRequired: true }
      const res = await client.execute({ ...input, ...scope })
      if (!res.ok && isBare(res, 'Unauthorized')) throw new OneApiError(401, String(res.data), 'One did not accept the connect key.')
      if (!res.ok && isBare(res, 'Forbidden')) {
        if (await consentStands()) return { ...res, blockedByGrant: true, refusal: 'grant' }
        return { ok: false, status: 403, data: null, connectRequired: true }
      }
      const refusal = oneRefusal(res)
      return { ...res, blockedByGrant: refusal === 'grant', refusal }
    },
  }
}
