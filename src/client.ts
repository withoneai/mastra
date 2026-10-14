export const DEFAULT_BASE_URL = 'https://api.withone.ai'

export interface OneClientOptions {
  secret: string
  baseUrl?: string
  fetch?: typeof fetch
  /** Sent as `x-one-agent` so One can attribute traffic to this adapter. */
  agent?: string
}

export interface OneConnection {
  key: string
  platform: string
  name?: string | null
  state?: string
  tags?: string[]
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
  constructor(readonly status: number, readonly body: string, message?: string) {
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
    return h
  }

  private async getJson<T>(path: string, scope?: RequestScope): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1${path}`, { headers: this.headers(scope) })
    const text = await res.text()
    if (!res.ok) throw new OneApiError(res.status, text)
    return JSON.parse(text) as T
  }

  async listConnections(params: { platform?: string; keys?: string[] } & RequestScope = {}): Promise<OneConnection[]> {
    const out: OneConnection[] = []
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ limit: '100', page: String(page) })
      if (params.platform) q.set('platform', params.platform)
      if (params.keys?.length) q.set('key', params.keys.join(','))
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

  async searchActions(platform: string, query: string, limit = 5): Promise<OneAction[]> {
    const q = new URLSearchParams({ query, limit: String(limit) })
    return this.getJson<OneAction[]>(`/available-actions/search/${encodeURIComponent(platform)}?${q}`)
  }

  async getKnowledge(actionId: string): Promise<OneActionKnowledge> {
    const res = await this.getJson<{ rows: OneActionKnowledge[] }>(`/knowledge?_id=${encodeURIComponent(actionId)}`)
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
