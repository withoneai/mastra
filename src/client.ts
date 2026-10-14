export const DEFAULT_BASE_URL = 'https://api.withone.ai'
export const DEFAULT_APP_URL = 'https://app.withone.ai'

const APP_URL_FOR_API: Record<string, string> = {
  'api.withone.ai': DEFAULT_APP_URL,
  'development-api.withone.ai': 'https://development.withone.ai',
}

/** One dashboard origin for an API base: explicit value, then `ONE_APP_URL`, then the dashboard paired with the API host. */
export function resolveAppUrl(baseUrl: string, explicit?: string): string {
  const fromHost = (() => {
    try {
      return APP_URL_FOR_API[new URL(baseUrl).host]
    } catch {
      return undefined
    }
  })()
  return (explicit ?? process.env.ONE_APP_URL ?? fromHost ?? DEFAULT_APP_URL).replace(/\/+$/, '')
}

export interface OneClientOptions {
  secret: string
  baseUrl?: string
  fetch?: typeof fetch
  /** Sent as `x-one-agent` so One can attribute traffic to this adapter. */
  agent?: string
}

export interface OneConnection {
  id?: string
  key: string
  platform: string
  name?: string | null
  state?: string
  tags?: string[]
  active?: boolean
}

export interface OneConnector {
  platform: string
  name: string
  title?: string
  description?: string
  image?: string
  category?: string
  tools?: number
  oauth?: boolean
  active?: boolean
}

export interface OneAction {
  systemId: string
  title: string
  key: string
  method: string
  path: string
  tags?: string[]
}

export interface FoundActions {
  platform: string
  intent: string
  confidence?: number
  /** The chosen action(s), each with a documentation digest in `knowledge`. */
  selected: Array<OneAction & { knowledge?: string }>
  alternatives?: OneAction[]
}

export interface OneActionKnowledge {
  _id: string
  title: string
  path: string
  method: string
  knowledge?: string
  baseUrl?: string
  tags?: string[]
  ioSchema?: {
    inputSchema?: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    ioExample?: unknown
  } | null
}

export interface RequestScope {
  /** End-user id for One Connect grant keys (`X-One-Connect-User-Id`). */
  connectUserId?: string
  /** The organization a Connect grant was made from (`X-One-Organization-Id`). */
  organizationId?: string
  /** The project a Connect grant was made from (`X-One-Project-Id`). */
  projectId?: string
}

export interface ExecuteRequest extends RequestScope {
  action: Pick<OneAction, 'systemId' | 'method' | 'path' | 'tags'>
  connectionKey: string
  pathVariables?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

export interface ExecuteResult {
  ok: boolean
  status: number
  data: unknown
}

export class OneApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `One API ${status}: ${body.slice(0, 300)}`)
    this.name = 'OneApiError'
  }
}

const CATALOG_PAGE_SIZE = 150
const EMPTY_PAGE_RETRIES = 4

export class OneClient {
  readonly baseUrl: string
  private readonly secret: string
  private readonly fetchImpl: typeof fetch
  private readonly agent: string

  constructor(opts: OneClientOptions) {
    if (!opts.secret) throw new Error('@withone/mastra: a One secret key is required (ONE_SECRET).')
    this.secret = opts.secret
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.agent = opts.agent ?? '@withone/mastra'
  }

  private headers(scope?: RequestScope): Record<string, string> {
    const h: Record<string, string> = {
      'x-one-secret': this.secret,
      'x-one-agent': this.agent,
      'x-one-source': 'mastra',
    }
    if (scope?.connectUserId) h['x-one-connect-user-id'] = scope.connectUserId
    if (scope?.organizationId) h['x-one-organization-id'] = scope.organizationId
    if (scope?.projectId) h['x-one-project-id'] = scope.projectId
    return h
  }

  private async getJson<T>(path: string, scope?: RequestScope): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1${path}`, { headers: this.headers(scope) })
    const text = await res.text()
    if (!res.ok) throw new OneApiError(res.status, text)
    return JSON.parse(text) as T
  }

  async listConnections(params: { platform?: string; keys?: string[]; tags?: string[] } & RequestScope = {}): Promise<OneConnection[]> {
    const out: OneConnection[] = []
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ limit: '100', page: String(page) })
      if (params.platform) q.set('platform', params.platform)
      if (params.keys?.length) q.set('key', params.keys.join(','))
      if (params.tags?.length) q.set('tags', params.tags.join(','))
      const res = await this.getJson<{ rows: OneConnection[]; pages: number }>(`/vault/connections?${q}`, params)
      out.push(...res.rows)
      if (page >= res.pages || res.rows.length === 0) break
    }
    return out
  }

  /** Full action catalog for a platform. Core paging can skip or repeat rows, so empty pages are retried and rows deduped. */
  async listActions(platform: string): Promise<OneAction[]> {
    const seen = new Map<string, OneAction>()
    let pages = 1
    for (let page = 1; page <= pages; page++) {
      let rows: OneAction[] = []
      for (let attempt = 0; attempt <= EMPTY_PAGE_RETRIES; attempt++) {
        const res = await this.getJson<{ rows: OneAction[]; pages: number }>(
          `/available-actions/${encodeURIComponent(platform)}?limit=${CATALOG_PAGE_SIZE}&page=${page}`,
        )
        pages = res.pages
        rows = res.rows
        if (rows.length > 0) break
      }
      for (const row of rows) seen.set(row.systemId, row)
    }
    return [...seen.values()]
  }

  /** Size of a platform's catalog from a single page request. */
  async countActions(platform: string): Promise<number> {
    const res = await this.getJson<{ total: number }>(`/available-actions/${encodeURIComponent(platform)}?limit=1&page=1`)
    return res.total
  }

  async listConnectors(): Promise<OneConnector[]> {
    const page = (n: number) => this.getJson<{ rows: OneConnector[]; pages: number }>(`/available-connectors?limit=150&page=${n}`)
    const first = await page(1)
    const rest = await Promise.all(Array.from({ length: Math.max(0, first.pages - 1) }, (_, i) => page(i + 2)))
    const seen = new Map<string, OneConnector>()
    for (const row of [first, ...rest].flatMap((r) => r.rows)) seen.set(row.platform, row)
    return [...seen.values()]
  }

  async whoami(): Promise<{ organization?: { id: string } | null; project?: { id: string } | null }> {
    return this.getJson('/users/whoami')
  }

  /** Replaces the connection's tag set. */
  async tagConnection(id: string, tags: string[]): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/vault/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    })
    if (!res.ok) throw new OneApiError(res.status, await res.text())
  }

  async deleteConnection(id: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/vault/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok && res.status !== 404) throw new OneApiError(res.status, await res.text())
  }

  /** `test` for `sk_test_…` keys, `live` otherwise. */
  get environment(): 'test' | 'live' {
    return this.secret.startsWith('sk_test_') ? 'test' : 'live'
  }

  async searchActions(platform: string, query: string, limit = 5, scope?: RequestScope): Promise<OneAction[]> {
    const q = new URLSearchParams({ query, limit: String(limit) })
    if (scope?.connectUserId) q.set('executeAgent', 'true')
    const res = await this.getJson<OneAction[] | { rows: OneAction[] }>(
      `/available-actions/search/${encodeURIComponent(platform)}?${q}`,
      scope,
    )
    return Array.isArray(res) ? res : res.rows
  }

  /** The connections a One Connect grant reaches. */
  async reachableConnections(scope: RequestScope, limit?: number): Promise<Array<{ key: string; platform: string; title?: string }>> {
    const res = await this.getJson<{ rows?: Array<{ key: string; platform: string; title?: string }> }>(
      `/connections/reachable${limit ? `?limit=${limit}` : ''}`,
      scope,
    )
    return res.rows ?? []
  }

  /** A platform's actions from the knowledge base (which a Connect grant can read), with their schemas. */
  async listKnowledge(platform: string, scope?: RequestScope, max = 2000): Promise<OneActionKnowledge[]> {
    const out: OneActionKnowledge[] = []
    for (let page = 1; out.length < max; page++) {
      const res = await this.getJson<{ rows?: OneActionKnowledge[]; pages?: number }>(
        `/knowledge?connectionPlatform=${encodeURIComponent(platform)}&limit=100&page=${page}`,
        scope,
      )
      out.push(...(res.rows ?? []))
      if (!res.rows?.length || page >= (res.pages ?? 1)) break
    }
    return out.slice(0, max)
  }

  /**
   * One's action selector: for each `{ platform, intent }` it picks the action, with a confidence
   * and a documentation digest, plus alternatives. Secret keys only; a Connect grant uses search.
   */
  async findActions(requests: Array<{ platform: string; intent: string }>, task?: string): Promise<FoundActions[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/available-actions/find`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ requests, ...(task ? { task } : {}) }),
    })
    const text = await res.text()
    if (!res.ok) throw new OneApiError(res.status, text)
    return JSON.parse(text) as FoundActions[]
  }

  async getKnowledge(actionId: string, scope?: RequestScope): Promise<OneActionKnowledge> {
    const res = await this.getJson<{ rows: OneActionKnowledge[] }>(`/knowledge?_id=${encodeURIComponent(actionId)}`, scope)
    const row = res.rows[0]
    if (!row) throw new OneApiError(404, '', `One action ${actionId} not found`)
    return row
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const { action } = req
    const method = action.method.toUpperCase()
    const path = fillPath(action.path, req.pathVariables)
    const url = new URL(`${this.baseUrl}/v1/passthrough${path.startsWith('/') ? path : `/${path}`}`)
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)))
      else url.searchParams.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }

    let body = req.body
    // Composed (medley) actions read the connection key from the body as well as the header.
    if (action.tags?.includes('custom') && method !== 'GET') {
      body = { ...(isRecord(body) ? body : {}), connectionKey: req.connectionKey }
    }

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        ...this.headers(req),
        'x-one-connection-key': req.connectionKey,
        'x-one-action-id': action.systemId,
        'content-type': 'application/json',
        accept: 'application/json, */*',
      },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await res.text()
    return { ok: res.ok, status: res.status, data: parseBody(text, res.headers.get('content-type')) }
  }
}

export function fillPath(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}|\{([^{}\s]+)\}/g, (match, a: string, b: string) => {
    const name = a ?? b
    const value = vars[name]
    return value === undefined || value === null ? match : encodeURIComponent(String(value))
  })
}

/** Passthrough doesn't always label JSON as JSON, so parse anything that looks like it. */
function parseBody(text: string, contentType: string | null): unknown {
  const trimmed = text.trimStart()
  if (!text || !(contentType?.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('['))) return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
