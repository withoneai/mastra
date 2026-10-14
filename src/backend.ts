import type { ExecuteResult, FoundActions, OneAction, OneActionKnowledge, OneClient } from './client.js'

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
