import { createTool } from '@mastra/core/tools'
import type { ToolsInput } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { DEFAULT_BASE_URL, OneClient, resolveAppUrl, type OneAction, type OneActionKnowledge } from './client.js'
import { connectBackend, secretBackend, type Backend, type BackendConnection, type OneConnectLike, type RunResult } from './backend.js'
import { matchesAny, toolIdFor, uniqueId } from './names.js'
import { OPEN_INPUT_SCHEMA, toToolInputSchema } from './schema.js'
import { TtlCache, mapLimit } from './util.js'

export interface PlatformConfig {
  /** Use this connection instead of the first usable one. */
  connectionKey?: string
  /** Only these actions, by One action id (`conn_mod_def::…`) or exact title. */
  actions?: string[]
  /** Tool-id globs to keep, e.g. `['gmail_list_*', 'gmail_send_*']`. */
  allowTools?: string[]
  /** Tool-id globs to drop. Applied after `allowTools`. */
  disallowTools?: string[]
  /** `true` for every tool on this platform, or tool-id globs. */
  requireApproval?: boolean | string[]
  /** Expose search + run tools instead of one tool per action. Default: automatic when the selection is too large. */
  mode?: 'typed' | 'discover'
}

export interface ResolveArgs {
  requestContext?: RequestContext<any>
}

export interface OneToolsOptions {
  /** Platforms to expose, keyed by One platform slug (`gmail`, `cal-com`, …). `true` = defaults. */
  platforms: Record<string, true | 'discover' | PlatformConfig>
  /** One secret key, when tools act for your own One account. Defaults to `process.env.ONE_SECRET`. */
  secret?: string
  /** Defaults to `process.env.ONE_BASE_URL` or `https://api.withone.ai`. */
  baseUrl?: string
  /**
   * A One Connect client (`createOneConnect` from `@withone/connect/server`), when tools
   * act for each of your end users with the access they granted. Requires `userId`.
   */
  connect?: OneConnectLike
  /** Which end user this request is for. Required with `connect`. */
  userId?: (args: ResolveArgs) => string | undefined
  /**
   * Link a user follows to connect a platform the agent needs. With `connect` this is
   * usually your authorize route (`/api/one/authorize?connector=<platform>`). Defaults
   * to One's dashboard when using a secret key. Return `undefined` to skip.
   */
  connectUrl?: (args: { platform: string; userId?: string }) => string | undefined
  /** One dashboard origin for the default connect link. Defaults to `ONE_APP_URL`, else the dashboard paired with the API (`development.withone.ai` for the dev API, `app.withone.ai` otherwise). */
  appUrl?: string
  /** Above this many matching actions a platform switches to discover mode. Default 40. */
  maxToolsPerPlatform?: number
  /** Catalog and schema cache lifetime. Default 10 minutes. */
  cacheTtlMs?: number
  /** Tool results longer than this many characters are truncated before reaching the model. Default 30 000. */
  maxResultChars?: number
  onWarning?: (message: string) => void
  fetch?: typeof fetch
}

export type OneToolsResolver = (args?: ResolveArgs) => Promise<ToolsInput>

const DEFAULT_MAX_TOOLS = 40
const DEFAULT_TTL = 10 * 60_000
const CONNECTION_TTL = 30_000
const DEFAULT_MAX_RESULT = 30_000
const KNOWLEDGE_CONCURRENCY = 8
const DESCRIPTION_LIMIT = 1_200

/**
 * Turns apps connected through One into Mastra tools.
 *
 * ```ts
 * new Agent({ tools: oneTools({ platforms: { gmail: true, slack: true } }), … })
 * ```
 *
 * The result is a resolver Mastra calls per request: connections added on One
 * appear without a redeploy, and with `connect` + `userId` each request acts
 * for one end user. A platform the caller hasn't connected yet becomes a
 * `connect_<platform>` tool that hands back a link to connect it.
 */
export function oneTools(options: OneToolsOptions): OneToolsResolver {
  if (options.connect && !options.userId) throw new Error('[@withone/mastra] `connect` needs a `userId` resolver.')
  const client = options.connect
    ? undefined
    : new OneClient({ secret: options.secret ?? process.env.ONE_SECRET ?? '', baseUrl: options.baseUrl ?? process.env.ONE_BASE_URL, fetch: options.fetch })

  const ttl = options.cacheTtlMs ?? DEFAULT_TTL
  const maxTools = options.maxToolsPerPlatform ?? DEFAULT_MAX_TOOLS
  const truncate = truncateFor(options.maxResultChars ?? DEFAULT_MAX_RESULT)
  const report = options.onWarning ?? ((m: string) => console.warn(`[@withone/mastra] ${m}`))
  const warned = new Set<string>()
  const warn = (m: string) => {
    if (warned.has(m)) return
    warned.add(m)
    report(m)
  }

  const appUrl = resolveAppUrl(client?.baseUrl ?? DEFAULT_BASE_URL, options.appUrl)
  const connectUrl =
    options.connectUrl ??
    (client ? ({ platform }: { platform: string }) => `${appUrl}/?env=${client.environment}#open=${encodeURIComponent(platform)}` : () => undefined)

  // The catalog and action docs are the same for every caller; connections are per caller.
  const catalogs = new TtlCache<OneAction[]>(ttl)
  const counts = new TtlCache<number>(ttl)
  const knowledge = new TtlCache<OneActionKnowledge>(ttl)
  const connections = new TtlCache<BackendConnection[]>(CONNECTION_TTL)

  return async (args = {}) => {
    let backend: Backend
    let userId: string | undefined
    if (options.connect) {
      userId = options.userId!(args)
      if (!userId) {
        warn('no userId for this request; One tools are disabled for it')
        return {}
      }
      backend = connectBackend(options.connect, userId)
    } else {
      backend = secretBackend(client!)
    }
    const getKnowledge = (id: string) => knowledge.get(id, () => backend.knowledge(id))

    const tools: ToolsInput = {}
    const taken = new Set<string>()
    const discoverPlatforms: DiscoverPlatform[] = []

    const entries = Object.entries(options.platforms).map(([platform, raw]) => ({
      platform,
      config: (raw === true ? {} : raw === 'discover' ? { mode: 'discover' } : raw) as PlatformConfig,
    }))
    const platformConnections = await Promise.all(
      entries.map(({ platform }) => connections.get(`${backend.scope}\u0000${platform}`, () => backend.connections(platform))),
    )

    for (const [i, { platform, config }] of entries.entries()) {
      const connection = pickConnection(platformConnections[i] ?? [], config.connectionKey)
      if (!connection) {
        const url = connectUrl({ platform, userId })
        if (url) {
          const id = uniqueId(toolIdFor('connect', platform), taken)
          taken.add(id)
          tools[id] = connectTool(id, platform, url)
        } else {
          warn(`no usable "${platform}" connection${userId ? ` for user ${userId}` : ''}; skipping its tools`)
        }
        continue
      }

      if (config.mode === 'discover') {
        discoverPlatforms.push({ platform, connectionKey: connection.key, config })
        continue
      }

      if (!hasExplicitSelection(config)) {
        const total = await counts.get(platform, () => backend.countActions(platform))
        if (total > maxTools) {
          warn(`"${platform}" has ${total} actions; exposing search/run tools instead. Narrow with \`actions\` or \`allowTools\` for typed tools.`)
          discoverPlatforms.push({ platform, connectionKey: connection.key, config })
          continue
        }
      }

      const catalog = await catalogs.get(platform, () => backend.listActions(platform))
      const selected = selectActions(platform, catalog, config)
      if (selected.length > maxTools) {
        warn(`"${platform}" selection matched ${selected.length} actions; keeping the first ${maxTools}.`)
        selected.length = maxTools
      }

      const docs = await mapLimit(selected, KNOWLEDGE_CONCURRENCY, (a) => getKnowledge(a.action.systemId).catch(() => undefined))
      selected.forEach(({ action, toolId }, j) => {
        const id = uniqueId(toolId, taken)
        taken.add(id)
        tools[id] = actionTool({
          backend,
          id,
          platform,
          action,
          doc: docs[j],
          connectionKey: connection.key,
          requireApproval: needsApproval(config, id),
          truncate,
          connectUrl: () => connectUrl({ platform, userId }),
        })
      })
    }

    if (discoverPlatforms.length) {
      Object.assign(tools, discoverTools(backend, discoverPlatforms, { getKnowledge, truncate, connectUrl: (platform) => connectUrl({ platform, userId }) }))
    }
    return tools
  }
}

export interface ActionToolInput {
  backend: Backend
  id: string
  platform: string
  action: OneAction
  doc?: OneActionKnowledge
  connectionKey: string
  requireApproval?: boolean
  description?: string
  truncate?: (output: unknown) => unknown
  connectUrl?: () => string | undefined
}

/** One Mastra tool for one One action, bound to one connection. */
export function actionTool(t: ActionToolInput) {
  const input = toToolInputSchema(t.doc?.ioSchema?.inputSchema) ?? OPEN_INPUT_SCHEMA
  return createTool({
    id: t.id,
    description: t.description ?? describe(t.platform, t.action, t.doc),
    inputSchema: input.schema as any,
    requireApproval: t.requireApproval ?? false,
    ...(t.truncate ? { toModelOutput: t.truncate } : {}),
    execute: async (data: any) =>
      withConnectHint(
        await t.backend.run({
          action: t.action,
          connectionKey: t.connectionKey,
          pathVariables: data?.path,
          query: data?.query,
          body: data?.body,
        }),
        t.platform,
        t.connectUrl,
      ),
  })
}

/** Stand-in for a platform the caller hasn't connected: hands the agent a link to give the user. */
function connectTool(id: string, platform: string, url: string) {
  return createTool({
    id,
    description: `The user has not connected ${platform} yet, so its tools are unavailable. Call this to get a link the user can open to connect ${platform}; its tools appear on the next message after they connect.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as any,
    execute: async () => ({
      connectRequired: true,
      platform,
      url,
      message: `Ask the user to connect ${platform} by opening ${url}, then to send their request again.`,
    }),
  })
}

function withConnectHint(result: RunResult, platform: string, connectUrl?: () => string | undefined): RunResult & { url?: string; message?: string } {
  if (!result.connectRequired) return result
  const url = connectUrl?.()
  return {
    ...result,
    ...(url ? { url, message: `The user's access to ${platform} has ended. Ask them to reconnect at ${url}.` } : {}),
  }
}

/** Stable tool ids for a platform catalog, in catalog order, with collisions suffixed. */
export function catalogToolIds(platform: string, catalog: OneAction[]): Map<string, OneAction> {
  const taken = new Set<string>()
  const out = new Map<string, OneAction>()
  for (const action of catalog) {
    const id = uniqueId(toolIdFor(platform, action.title), taken)
    taken.add(id)
    out.set(id, action)
  }
  return out
}

/** A `toModelOutput` that caps the result's size. It must return an AI SDK tool-result part, not the raw value. */
export function truncateFor(maxChars: number) {
  return (output: unknown): { type: 'text'; value: string } | { type: 'json'; value: unknown } => {
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    if (text === undefined) return { type: 'json', value: null }
    if (text.length <= maxChars) return typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: output }
    return {
      type: 'text',
      value: `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters; narrow the request with filters or pagination]`,
    }
  }
}

function pickConnection(all: BackendConnection[], key?: string): BackendConnection | undefined {
  if (key) return all.find((c) => c.key === key && c.usable)
  return all.find((c) => c.usable)
}

interface Selected {
  action: OneAction
  toolId: string
}

function selectActions(platform: string, catalog: OneAction[], config: PlatformConfig): Selected[] {
  const wanted = config.actions?.map((a) => a.toLowerCase())
  return [...catalogToolIds(platform, catalog)]
    .map(([toolId, action]) => ({ action, toolId }))
    .filter(({ action }) => !wanted || wanted.includes(action.systemId.toLowerCase()) || wanted.includes(action.title.toLowerCase()))
    .filter(({ toolId }) => !config.allowTools?.length || matchesAny(toolId, config.allowTools))
    .filter(({ toolId }) => !matchesAny(toolId, config.disallowTools))
}

function hasExplicitSelection(config: PlatformConfig): boolean {
  return Boolean(config.actions?.length || config.allowTools?.length)
}

function needsApproval(config: PlatformConfig, toolId: string): boolean {
  if (config.requireApproval === true) return true
  return Array.isArray(config.requireApproval) && matchesAny(toolId, config.requireApproval)
}

export function describe(platform: string, action: OneAction, doc?: OneActionKnowledge): string {
  const summary =
    (typeof doc?.ioSchema?.inputSchema?.description === 'string' && doc.ioSchema.inputSchema.description) ||
    section(doc?.knowledge, 'Description') ||
    ''
  const head = `${action.title} (${platform}).`
  return (summary ? `${head} ${summary}` : head).slice(0, DESCRIPTION_LIMIT)
}

function section(markdown: string | undefined, heading: string): string | undefined {
  if (!markdown) return undefined
  const match = markdown.match(new RegExp(`^##\\s+${heading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`, 'm'))
  return match?.[1]?.trim().replace(/\s+/g, ' ')
}

interface DiscoverPlatform {
  platform: string
  connectionKey: string
  config: PlatformConfig
}

function discoverTools(
  backend: Backend,
  platforms: DiscoverPlatform[],
  ctx: {
    getKnowledge: (id: string) => Promise<OneActionKnowledge>
    truncate: (output: unknown) => unknown
    connectUrl: (platform: string) => string | undefined
  },
): ToolsInput {
  const byPlatform = new Map(platforms.map((p) => [p.platform, p]))
  const names = [...byPlatform.keys()]

  // An action may only run on a platform this agent enabled, whatever id the model passes.
  const resolveAction = async (actionId: string) => {
    const doc = await ctx.getKnowledge(actionId)
    const platform = (doc as { connectionPlatform?: string; platform?: string }).connectionPlatform ?? (doc as { platform?: string }).platform
    const entry = platform ? byPlatform.get(platform) : undefined
    return { doc, entry, toolId: entry ? toolIdFor(entry.platform, doc.title) : undefined }
  }

  return {
    one_find_actions: createTool({
      id: 'one_find_actions',
      description: `Search the actions available on ${names.join(', ')}. Returns action ids to pass to one_get_action and one_run_action.`,
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: names, description: 'One platform slug.' },
          query: { type: 'string', description: 'What you want to do, e.g. "list open issues".' },
        },
        required: ['platform', 'query'],
        additionalProperties: false,
      } as any,
      execute: async ({ platform, query }: any) => {
        const found = await backend.searchActions(platform, query, 8)
        return found.map((a) => ({ actionId: a.systemId, title: a.title, method: a.method, path: a.path }))
      },
    }),
    one_get_action: createTool({
      id: 'one_get_action',
      description: 'Read the documentation and input schema for an action before running it.',
      inputSchema: {
        type: 'object',
        properties: { actionId: { type: 'string' } },
        required: ['actionId'],
        additionalProperties: false,
      } as any,
      toModelOutput: ctx.truncate,
      execute: async ({ actionId }: any) => {
        const { doc, entry } = await resolveAction(actionId)
        if (!entry) return { error: `Action ${actionId} is not on an enabled platform.` }
        return {
          title: doc.title,
          method: doc.method,
          path: doc.path,
          inputSchema: toToolInputSchema(doc.ioSchema?.inputSchema)?.schema ?? null,
          knowledge: doc.knowledge,
        }
      },
    }),
    one_run_action: createTool({
      id: 'one_run_action',
      description: 'Run an action found with one_find_actions. Pass path parameters, query parameters and body as described by one_get_action.',
      inputSchema: {
        type: 'object',
        properties: {
          actionId: { type: 'string' },
          path: { type: 'object', additionalProperties: true },
          query: { type: 'object', additionalProperties: true },
          body: {},
        },
        required: ['actionId'],
        additionalProperties: false,
      } as any,
      requireApproval: async (input: any) => {
        const { entry, toolId } = await resolveAction(input.actionId)
        return entry && toolId ? needsApproval(entry.config, toolId) : false
      },
      toModelOutput: ctx.truncate,
      execute: async ({ actionId, path, query, body }: any) => {
        const { doc, entry, toolId } = await resolveAction(actionId)
        if (!entry || !toolId) return { error: `Action ${actionId} is not on an enabled platform.` }
        if (entry.config.allowTools?.length && !matchesAny(toolId, entry.config.allowTools)) return { error: `Action "${doc.title}" is not allowed.` }
        if (matchesAny(toolId, entry.config.disallowTools)) return { error: `Action "${doc.title}" is not allowed.` }
        const result = await backend.run({
          action: { systemId: doc._id, method: doc.method, path: doc.path, tags: doc.tags },
          connectionKey: entry.connectionKey,
          pathVariables: path,
          query,
          body,
        })
        return withConnectHint(result, entry.platform, () => ctx.connectUrl(entry.platform))
      },
    }),
  }
}
