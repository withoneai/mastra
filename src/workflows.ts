import { createStep } from '@mastra/core/workflows'
import type { RequestContext } from '@mastra/core/request-context'
import { OneApiError, OneClient, type OneAction, type OneConnection } from './client.js'
import { OPEN_INPUT_SCHEMA, toToolInputSchema } from './schema.js'
import { catalogToolIds, describe } from './tools.js'

export interface OneStepOptions {
  /** One platform slug, e.g. `stripe`. */
  platform: string
  /** Tool id (`stripe_create_a_refund`), One action id (`conn_mod_def::…`) or exact action title. */
  action: string
  /** Step id. Defaults to the tool id. */
  id?: string
  /** Use this connection instead of the first operational one. */
  connectionKey?: string
  /** Per-run end user for One Connect grant keys. */
  connectUserId?: (args: { requestContext: RequestContext<any> }) => string | undefined
  /** Suspend before running until resumed with `{ approved: true }`. */
  requireApproval?: boolean
  /** On a declined approval, end the workflow here (`'stop'`, default) or pass a declined result to the next step. */
  onDecline?: 'stop' | 'continue'
  /** Fail the step on a non-2xx response. Default true. */
  failOnError?: boolean
  secret?: string
  baseUrl?: string
  fetch?: typeof fetch
}

export interface OneStepOutput {
  ok: boolean
  status: number
  data: unknown
  declined?: boolean
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'number' },
    data: {},
    declined: { type: 'boolean' },
  },
  required: ['ok', 'status'],
  additionalProperties: false,
}

const SUSPEND_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    platform: { type: 'string' },
    action: { type: 'string' },
    input: {},
  },
  required: ['reason', 'platform', 'action'],
}

const RESUME_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, note: { type: 'string' } },
  required: ['approved'],
}

/**
 * A workflow step that runs exactly one One action.
 *
 * ```ts
 * const refund = await oneStep({ platform: 'stripe', action: 'stripe_create_a_refund', requireApproval: true })
 * createWorkflow({ … }).then(refund).commit()
 * ```
 *
 * Async because the step's input schema comes from One's catalog.
 */
export async function oneStep(options: OneStepOptions) {
  const client = new OneClient({
    secret: options.secret ?? process.env.ONE_SECRET ?? '',
    baseUrl: options.baseUrl ?? process.env.ONE_BASE_URL,
    fetch: options.fetch,
  })
  const { toolId, action } = await findAction(client, options.platform, options.action)
  const doc = await client.getKnowledge(action.systemId)
  const input = toToolInputSchema(doc.ioSchema?.inputSchema) ?? OPEN_INPUT_SCHEMA
  const failOnError = options.failOnError ?? true

  return createStep({
    id: options.id ?? toolId,
    description: describe(options.platform, action, doc),
    inputSchema: input.schema as any,
    outputSchema: OUTPUT_SCHEMA as any,
    ...(options.requireApproval ? { suspendSchema: SUSPEND_SCHEMA as any, resumeSchema: RESUME_SCHEMA as any } : {}),
    execute: async ({ inputData, requestContext, resumeData, suspend, bail }: any): Promise<OneStepOutput> => {
      if (options.requireApproval) {
        if (!resumeData) {
          return suspend({
            reason: `Approve "${action.title}" on ${options.platform}?`,
            platform: options.platform,
            action: action.title,
            input: inputData,
          })
        }
        if (!resumeData.approved) {
          const declined = { ok: false, status: 0, data: { note: resumeData.note ?? null }, declined: true }
          return options.onDecline === 'continue' ? declined : bail(declined)
        }
      }

      const connectUserId = options.connectUserId?.({ requestContext })
      const connectionKey = options.connectionKey ?? (await operationalKey(client, options.platform, connectUserId))
      const res = await client.execute({
        action,
        connectionKey,
        pathVariables: inputData?.path,
        query: inputData?.query,
        body: inputData?.body,
        connectUserId,
      })
      if (!res.ok && failOnError) {
        throw new OneApiError(res.status, JSON.stringify(res.data), `${action.title} failed with ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`)
      }
      return res
    },
  })
}

async function findAction(client: OneClient, platform: string, ref: string): Promise<{ toolId: string; action: OneAction }> {
  const ids = catalogToolIds(platform, await client.listActions(platform))
  const wanted = ref.toLowerCase()
  for (const [toolId, action] of ids) {
    if (toolId === wanted || action.systemId.toLowerCase() === wanted || action.title.toLowerCase() === wanted) {
      return { toolId, action }
    }
  }
  throw new Error(`[@withone/mastra] no "${platform}" action matches "${ref}". Use a tool id, a One action id, or the exact title.`)
}

async function operationalKey(client: OneClient, platform: string, connectUserId?: string): Promise<string> {
  const all: OneConnection[] = await client.listConnections({ platform, connectUserId })
  const match = all.find((c) => c.state === 'operational' && c.active !== false)
  if (!match) throw new Error(`[@withone/mastra] no operational "${platform}" connection${connectUserId ? ` for user ${connectUserId}` : ''}`)
  return match.key
}
