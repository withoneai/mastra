import { randomUUID } from 'node:crypto'
import { BaseToolProvider, type BaseToolProviderOptions } from '@mastra/core/tool-provider'
import type {
  AuthFlowStatus,
  AuthorizeOpts,
  ListConnectionsOpts,
  ListConnectionsResult,
  ListToolsOpts,
  ListToolsResult,
  ResolveToolsOpts,
  ToolProviderCapabilities,
  ToolProviderHealth,
  ToolProviderInfo,
  ToolProviderToolkit,
} from '@mastra/core/tool-provider'
import type { ToolAction } from '@mastra/core/tools'
import { OneClient, resolveAppUrl, type OneAction, type OneConnection, type OneConnector } from './client.js'
import { matchesAny } from './names.js'
import { actionTool, catalogToolIds, truncateFor } from './tools.js'
import { secretBackend, type Backend } from './backend.js'
import { TtlCache, mapLimit } from './util.js'

export interface OneToolProviderOptions extends BaseToolProviderOptions {
  /** One secret key. Defaults to `process.env.ONE_SECRET`. */
  secret?: string
  /** Defaults to `process.env.ONE_BASE_URL` or `https://api.withone.ai`. */
  baseUrl?: string
  /** One dashboard origin for the Connect flow. Defaults to `ONE_APP_URL`, else the dashboard paired with the API. */
  appUrl?: string
  /** Tool-id globs that require approval before running. */
  requireApproval?: string[]
  cacheTtlMs?: number
  maxResultChars?: number
  fetch?: typeof fetch
}

const PROVIDER_ID = 'one'
const AUTH_PREFIX = 'oneauth_'
const DEFAULT_TTL = 10 * 60_000
const KNOWLEDGE_CONCURRENCY = 8
const MAX_SEARCH_TOOLKITS = 3

interface PendingAuth {
  platform: string
  known: Set<string>
  resolvedKey?: string
}

/**
 * Exposes One in Mastra Studio's tool picker and Agent Builder.
 *
 * ```ts
 * new Mastra({ storage, editor: new MastraEditor({ toolProviders: { one: new OneToolProvider() } }) })
 * ```
 *
 * Toolkits are One platforms, tools are One actions, connections are One
 * connection keys. Authorizing opens One's dashboard on the platform's
 * connect dialog; the new connection is tagged with the auth id so pins
 * survive restarts.
 */
export class OneToolProvider extends BaseToolProvider {
  readonly info: ToolProviderInfo = {
    id: PROVIDER_ID,
    name: 'One',
    description: 'Act in 972+ apps through your One connections',
  }

  readonly capabilities: ToolProviderCapabilities = {
    multipleConnectionsPerToolkit: true,
    batchConnectionStatus: true,
    reauthorizeReusesConnectionId: false,
    supportsRevoke: true,
  }

  private readonly client: OneClient
  private readonly backend: Backend
  private readonly appUrl: string
  private readonly approvals: string[]
  private readonly truncate: (output: unknown) => unknown
  private readonly catalogs: TtlCache<OneAction[]>
  private readonly connectors: TtlCache<OneConnector[]>
  private readonly pending = new Map<string, PendingAuth>()

  constructor(options: OneToolProviderOptions = {}) {
    super(options)
    this.client = new OneClient({
      secret: options.secret ?? process.env.ONE_SECRET ?? '',
      baseUrl: options.baseUrl ?? process.env.ONE_BASE_URL,
      fetch: options.fetch,
    })
    this.backend = secretBackend(this.client)
    this.appUrl = resolveAppUrl(this.client.baseUrl, options.appUrl)
    this.approvals = options.requireApproval ?? []
    this.truncate = truncateFor(options.maxResultChars ?? 30_000)
    this.catalogs = new TtlCache(options.cacheTtlMs ?? DEFAULT_TTL)
    this.connectors = new TtlCache(options.cacheTtlMs ?? DEFAULT_TTL)
  }

  protected async listAllToolkits(): Promise<ToolProviderToolkit[]> {
    const connectors = await this.connectors.get('all', () => this.client.listConnectors())
    return connectors
      .filter((c) => c.active !== false)
      .map((c) => ({ slug: c.platform, name: c.title ?? c.name, description: c.description, icon: c.image }))
  }

  protected async listAllTools(opts: ListToolsOpts): Promise<ListToolsResult> {
    const page = opts.page ?? 1
    const perPage = Math.min(opts.perPage ?? 50, 200)
    let toolkits = opts.toolkit ? [opts.toolkit] : [...this.allowedToolkits].filter((t) => !t.includes('*'))
    let search = opts.search
    if (toolkits.length === 0 && search) {
      // Studio's "All" view searches without a toolkit: treat the query as an app name.
      toolkits = await this.toolkitsMatching(search)
      search = undefined
    }
    if (toolkits.length === 0) return { data: [], pagination: { page, perPage, hasMore: false } }

    const rows: ListToolsResult['data'] = []
    for (const toolkit of toolkits) {
      let ids = await this.toolIds(toolkit)
      if (search) {
        const rank = new Map((await this.client.searchActions(toolkit, search, perPage)).map((a, i) => [a.systemId, i]))
        ids = new Map(
          [...ids]
            .filter(([, action]) => rank.has(action.systemId))
            .sort(([, a], [, b]) => rank.get(a.systemId)! - rank.get(b.systemId)!),
        )
      }
      for (const [slug, action] of ids) rows.push({ slug, name: action.title, toolkit, description: `${action.method} ${action.path}` })
    }
    const start = (page - 1) * perPage
    return { data: rows.slice(start, start + perPage), pagination: { page, perPage, hasMore: start + perPage < rows.length } }
  }

  async getToolSchema(toolSlug: string): Promise<Record<string, unknown> | null> {
    const platform = await this.platformOfSlug(toolSlug)
    if (!platform) return null
    const tool = (await this.buildTools(platform, [toolSlug], { connectionKey: '' }))[toolSlug]
    const schema = tool?.inputSchema as any
    return schema?.['~standard']?.jsonSchema?.input?.({ target: 'draft-07' }) ?? null
  }

  async resolveToolsVNext(opts: ResolveToolsOpts): Promise<Record<string, ToolAction<any, any, any>>> {
    if (opts.toolSlugs.length === 0) return {}
    const platform = opts.toolkit ?? (await this.platformOfSlug(opts.toolSlugs[0]!))
    if (!platform) return {}
    const connectionKey = await this.connectionKeyFor(opts.connectionId, platform)
    if (!connectionKey) throw new Error(`[one] no operational "${platform}" connection for ${opts.connectionId}`)
    const descriptions = Object.fromEntries(
      Object.entries(opts.toolMeta ?? {}).flatMap(([slug, meta]) => (meta.description ? [[slug, meta.description]] : [])),
    )
    return this.buildTools(platform, opts.toolSlugs, { connectionKey, descriptions })
  }

  async authorize(opts: AuthorizeOpts): Promise<{ url: string; authId: string }> {
    const existing = await this.client.listConnections({ platform: opts.toolkit })
    const authId = `${AUTH_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 20)}`
    this.pending.set(authId, { platform: opts.toolkit, known: new Set(existing.map((c) => c.key)) })

    const params = new URLSearchParams({ env: this.client.environment })
    const me = await this.client.whoami().catch(() => undefined)
    if (me?.organization?.id) params.set('orgId', me.organization.id)
    if (me?.project?.id) params.set('projectId', me.project.id)
    return { url: `${this.appUrl}/?${params}#open=${encodeURIComponent(opts.toolkit)}`, authId }
  }

  async getAuthStatus(authId: string): Promise<AuthFlowStatus> {
    const flow = this.pending.get(authId)
    if (!flow) return (await this.findTagged(authId)) ? 'completed' : 'failed'
    if (flow.resolvedKey) return 'completed'

    const fresh = (await this.client.listConnections({ platform: flow.platform })).filter((c) => !flow.known.has(c.key))
    const ready = fresh.find((c) => c.state === 'operational')
    if (ready) {
      flow.resolvedKey = ready.key
      if (ready.id) await this.client.tagConnection(ready.id, [...(ready.tags ?? []), authId]).catch(() => undefined)
      return 'completed'
    }
    return fresh.some((c) => c.state === 'failed') ? 'failed' : 'pending'
  }

  async getConnectionStatus(opts: { items: Array<{ connectionId: string; toolkit: string }> }) {
    const result: Record<string, { connected: boolean }> = {}
    const byToolkit = new Map<string, OneConnection[]>()
    for (const toolkit of new Set(opts.items.map((i) => i.toolkit))) {
      byToolkit.set(toolkit, await this.client.listConnections({ platform: toolkit }))
    }
    for (const { connectionId, toolkit } of opts.items) {
      const key = await this.connectionKeyFor(connectionId, toolkit, byToolkit.get(toolkit))
      result[connectionId] = { connected: Boolean(key) }
    }
    return result
  }

  async listConnections(opts: ListConnectionsOpts): Promise<ListConnectionsResult> {
    const page = opts.page ?? 1
    const perPage = Math.min(opts.perPage ?? 50, 200)
    const all = await this.client.listConnections({ platform: opts.toolkit })
    const start = (page - 1) * perPage
    return {
      items: all.slice(start, start + perPage).map((c) => ({
        connectionId: c.key,
        status: c.active === false ? 'inactive' : c.state === 'operational' ? 'active' : c.state === 'failed' ? 'failed' : 'pending',
      })),
      pagination: { page, perPage, hasMore: start + perPage < all.length, total: all.length },
    }
  }

  async revokeConnection(connectionId: string): Promise<void> {
    const platform = connectionId.split('::')[1]
    const connection = isConnectionKey(connectionId)
      ? (await this.client.listConnections({ platform, keys: [connectionId] })).find((c) => c.key === connectionId)
      : await this.findTagged(connectionId)
    if (connection?.id) await this.client.deleteConnection(connection.id)
  }

  async getHealth(): Promise<ToolProviderHealth> {
    try {
      await this.client.whoami()
      return { ok: true, details: { environment: this.client.environment, baseUrl: this.client.baseUrl } }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'One API unreachable' }
    }
  }

  private async toolkitsMatching(query: string): Promise<string[]> {
    const q = query.trim().toLowerCase()
    const connectors = await this.connectors.get('all', () => this.client.listConnectors())
    const score = (c: OneConnector) => {
      const names = [c.platform, c.name, c.title ?? ''].map((n) => n.toLowerCase())
      if (names.some((n) => n === q)) return 0
      if (names.some((n) => n.startsWith(q))) return 1
      return names.some((n) => n.includes(q)) ? 2 : 3
    }
    return connectors
      .filter((c) => c.active !== false && score(c) < 3)
      .sort((a, b) => score(a) - score(b))
      .slice(0, MAX_SEARCH_TOOLKITS)
      .map((c) => c.platform)
  }

  private async toolIds(platform: string): Promise<Map<string, OneAction>> {
    return catalogToolIds(platform, await this.catalogs.get(platform, () => this.client.listActions(platform)))
  }

  private async platformOfSlug(slug: string): Promise<string | undefined> {
    const candidates = this.allowedToolkits.length ? [...this.allowedToolkits] : []
    for (const platform of candidates) if ((await this.toolIds(platform)).has(slug)) return platform
    // Tool ids are `<platform>_<action>`; platform slugs use `-` where ids use `_`.
    const connectors = await this.connectors.get('all', () => this.client.listConnectors())
    const match = connectors
      .map((c) => c.platform)
      .filter((p) => slug.startsWith(`${p.replace(/-/g, '_')}_`))
      .sort((a, b) => b.length - a.length)[0]
    return match
  }

  private async buildTools(
    platform: string,
    slugs: string[],
    opts: { connectionKey: string; descriptions?: Record<string, string> },
  ): Promise<Record<string, ToolAction<any, any, any>>> {
    const ids = await this.toolIds(platform)
    const wanted = slugs.flatMap((slug) => {
      const action = ids.get(slug)
      return action ? [{ slug, action }] : []
    })
    const docs = await mapLimit(wanted, KNOWLEDGE_CONCURRENCY, ({ action }) =>
      this.client.getKnowledge(action.systemId).catch(() => undefined),
    )
    const out: Record<string, ToolAction<any, any, any>> = {}
    wanted.forEach(({ slug, action }, i) => {
      out[slug] = actionTool({
        backend: this.backend,
        id: slug,
        platform,
        action,
        doc: docs[i],
        connectionKey: opts.connectionKey,
        description: opts.descriptions?.[slug],
        requireApproval: matchesAny(slug, this.approvals),
        truncate: this.truncate,
      }) as ToolAction<any, any, any>
    })
    return out
  }

  /** A pinned connection id is either a One connection key or an auth id from `authorize`. */
  private async connectionKeyFor(connectionId: string, platform: string, known?: OneConnection[]): Promise<string | undefined> {
    if (isConnectionKey(connectionId)) {
      const list = known ?? (await this.client.listConnections({ platform, keys: [connectionId] }))
      return list.find((c) => c.key === connectionId && c.state === 'operational' && c.active !== false)?.key
    }
    if (connectionId.startsWith(AUTH_PREFIX)) {
      const flow = this.pending.get(connectionId)
      if (flow?.resolvedKey) return flow.resolvedKey
      return (await this.findTagged(connectionId, platform))?.key
    }
    return undefined
  }

  private async findTagged(authId: string, platform?: string): Promise<OneConnection | undefined> {
    const all = await this.client.listConnections({ platform, tags: [authId] })
    return all.find((c) => c.tags?.includes(authId) && c.state === 'operational')
  }
}

function isConnectionKey(value: string): boolean {
  return value.split('::').length >= 4
}
