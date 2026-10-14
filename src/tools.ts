import { createTool } from '@mastra/core/tools'
import type { ToolsInput } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { OneClient, type OneAction, type OneActionKnowledge, type OneConnection } from './client.js'
import { matchesAny, toolIdFor, uniqueId } from './names.js'
import { OPEN_INPUT_SCHEMA, toToolInputSchema } from './schema.js'
import { TtlCache, mapLimit } from './util.js'

export interface PlatformConfig {
  /** Use this connection instead of the first operational one on the account. */
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
  /** One secret key. Defaults to `process.env.ONE_SECRET`. */
  secret?: string
  /** Defaults to `process.env.ONE_BASE_URL` or `https://api.withone.ai`. */
  baseUrl?: string
  /** Platforms to expose, keyed by One platform slug (`gmail`, `cal-com`, …). `true` = defaults. */
  platforms: Record<string, true | 'discover' | PlatformConfig>
  /** Per-request end user, for One Connect grant keys. Sent as `X-One-Connect-User-Id`. */
  connectUserId?: (args: ResolveArgs) => string | undefined
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
 * Turns the apps connected to a One account into Mastra tools.
 *
 * ```ts
 * new Agent({ tools: oneTools({ platforms: { gmail: true, slack: true } }), … })
 * ```
 *
 * The result is a resolver Mastra calls per request, so connections added on
 * One appear without a redeploy and `connectUserId` can scope each request to
 * one end user.
 */
export function oneTools(options: OneToolsOptions): OneToolsResolver {
  const secret = options.secret ?? process.env.ONE_SECRET
  const client = new OneClient({
    secret: secret ?? '',
    baseUrl: options.baseUrl ?? process.env.ONE_BASE_URL,
    fetch: options.fetch,
  })
  const ttl = options.cacheTtlMs ?? DEFAULT_TTL
  const maxTools = options.maxToolsPerPlatform ?? DEFAULT_MAX_TOOLS
  const maxResult = options.maxResultChars ?? DEFAULT_MAX_RESULT
  const report = options.onWarning ?? ((m: string) => console.warn(`[@withone/mastra] ${m}`))
  const warned = new Set<string>()
  const warn = (m: string) => {
    if (warned.has(m)) return
    warned.add(m)
    report(m)
  }

  const catalogs = new TtlCache<OneAction[]>(ttl)
  const counts = new TtlCache<number>(ttl)
  const knowledge = new TtlCache<OneActionKnowledge>(ttl)
  const connections = new TtlCache<OneConnection[]>(CONNECTION_TTL)

  const getKnowledge = (id: string) => knowledge.get(id, () => client.getKnowledge(id))

  const truncate = truncateFor(maxResult)

  return async (args = {}) => {
    const connectUserId = options.connectUserId?.(args)
    const scope = { connectUserId }
    const tools: ToolsInput = {}
    const taken = new Set<string>()
    const discoverPlatforms: Array<{ platform: string; connectionKey: string; config: PlatformConfig }> = []

    const entries = Object.entries(options.platforms).map(([platform, raw]) => ({
      platform,
      config: (raw === true ? {} : raw === 'discover' ? { mode: 'discover' } : raw) as PlatformConfig,
    }))
    const platformConnections = await Promise.all(
      entries.map(({ platform }) =>
        connections.get(`${connectUserId ?? ''}\u0000${platform}`, () => client.listConnections({ ...scope, platform })),
      ),
    )

    for (const [i, { platform, config }] of entries.entries()) {
      const connection = pickConnection(platformConnections[i] ?? [], platform, config.connectionKey)
      if (!connection) {
        warn(`no operational "${platform}" connection${connectUserId ? ` for user ${connectUserId}` : ''}; skipping its tools`)
        continue
      }

      if (config.mode === 'discover') {
        discoverPlatforms.push({ platform, connectionKey: connection.key, config })
        continue
      }

      if (!hasExplicitSelection(config)) {
        const total = await counts.get(platform, () => client.countActions(platform))
        if (total > maxTools) {
          warn(`"${platform}" has ${total} actions; exposing search/run tools instead. Narrow with \`actions\` or \`allowTools\` for typed tools.`)
          discoverPlatforms.push({ platform, connectionKey: connection.key, config })
          continue
        }
      }

      const catalog = await catalogs.get(platform, () => client.listActions(platform))
      const selected = selectActions(platform, catalog, config)

      if (selected.length > maxTools) {
        warn(`"${platform}" selection matched ${selected.length} actions; keeping the first ${maxTools}.`)
        selected.length = maxTools
      }

      const docs = await mapLimit(selected, KNOWLEDGE_CONCURRENCY, (a) => getKnowledge(a.action.systemId).catch(() => undefined))

      selected.forEach(({ action, toolId }, i) => {
        const id = uniqueId(toolId, taken)
        taken.add(id)
        tools[id] = actionTool({
          client,
          id,
          platform,
          action,
          doc: docs[i],
          connectionKey: connection.key,
          connectUserId,
          requireApproval: needsApproval(config, id),
          truncate,
        })
      })
    }

    if (discoverPlatforms.length) {
      Object.assign(tools, discoverTools(client, discoverPlatforms, { getKnowledge, connectUserId, truncate }))
    }
    return tools
  }
}

export interface ActionToolInput {
  client: OneClient
  id: string
  platform: string
  action: OneAction
  doc?: OneActionKnowledge
  connectionKey: string
  connectUserId?: string
  requireApproval?: boolean
  description?: string
  truncate?: (output: unknown) => unknown
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
      t.client.execute({
        action: t.action,
        connectionKey: t.connectionKey,
        pathVariables: data?.path,
        query: data?.query,
        body: data?.body,
        connectUserId: t.connectUserId,
      }),
  })
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

export function truncateFor(maxChars: number) {
  return (output: unknown) => {
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    if (text === undefined || text.length <= maxChars) return output
    return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters; narrow the request with filters or pagination]`
  }
}

function pickConnection(all: OneConnection[], platform: string, key?: string): OneConnection | undefined {
  if (key) return all.find((c) => c.key === key)
  const candidates = all.filter((c) => c.platform === platform && c.active !== false)
  return candidates.find((c) => c.state === 'operational') ?? candidates.find((c) => !c.state)
}

interface Selected {
  action: OneAction
  toolId: string
}

function selectActions(platform: string, catalog: OneAction[], config: PlatformConfig): Selected[] {
  const wanted = config.actions?.map((a) => a.toLowerCase())
  return catalog
    .filter((a) => !wanted || wanted.includes(a.systemId.toLowerCase()) || wanted.includes(a.title.toLowerCase()))
    .map((action) => ({ action, toolId: toolIdFor(platform, action.title) }))
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

function discoverTools(
  client: OneClient,
  platforms: Array<{ platform: string; connectionKey: string; config: PlatformConfig }>,
  ctx: {
    getKnowledge: (id: string) => Promise<OneActionKnowledge>
    connectUserId?: string
    truncate: (output: unknown) => unknown
  },
): ToolsInput {
  const byPlatform = new Map(platforms.map((p) => [p.platform, p]))
  const names = [...byPlatform.keys()]
  const platformSchema = { type: 'string', enum: names, description: 'One platform slug.' }

  const actionPlatform = async (actionId: string) => {
    const doc = await ctx.getKnowledge(actionId)
    return { doc, platform: (doc as { connectionPlatform?: string }).connectionPlatform }
  }

  return {
    one_find_actions: createTool({
      id: 'one_find_actions',
      description: `Search the actions available on ${names.join(', ')}. Returns action ids to pass to one_get_action and one_run_action.`,
      inputSchema: {
        type: 'object',
        properties: {
          platform: platformSchema,
          query: { type: 'string', description: 'What you want to do, e.g. "list open issues".' },
        },
        required: ['platform', 'query'],
        additionalProperties: false,
      } as any,
      execute: async ({ platform, query }: any) => {
        const found = await client.searchActions(platform, query, 8)
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
        const { doc, platform } = await actionPlatform(actionId)
        if (!platform || !byPlatform.has(platform)) return { error: `Action ${actionId} is not on an enabled platform.` }
        const input = toToolInputSchema(doc.ioSchema?.inputSchema)
        return {
          title: doc.title,
          method: doc.method,
          path: doc.path,
          inputSchema: input?.schema ?? null,
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
        const { doc, platform } = await actionPlatform(input.actionId)
        const entry = platform ? byPlatform.get(platform) : undefined
        return entry ? needsApproval(entry.config, toolIdFor(entry.platform, doc.title)) : false
      },
      toModelOutput: ctx.truncate,
      execute: async ({ actionId, path, query, body }: any) => {
        const { doc, platform } = await actionPlatform(actionId)
        const entry = platform ? byPlatform.get(platform) : undefined
        if (!entry) return { error: `Action ${actionId} is not on an enabled platform.` }
        const toolId = toolIdFor(entry.platform, doc.title)
        if (entry.config.allowTools?.length && !matchesAny(toolId, entry.config.allowTools)) {
          return { error: `Action "${doc.title}" is not allowed.` }
        }
        if (matchesAny(toolId, entry.config.disallowTools)) return { error: `Action "${doc.title}" is not allowed.` }
        return client.execute({
          action: { systemId: doc._id, method: doc.method, path: doc.path, tags: doc.tags },
          connectionKey: entry.connectionKey,
          pathVariables: path,
          query,
          body,
          connectUserId: ctx.connectUserId,
        })
      },
    }),
  }
}
