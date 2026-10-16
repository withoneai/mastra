import { createHmac, timingSafeEqual } from 'node:crypto'
import { registerApiRoute } from '@mastra/core/server'
import { RequestContext } from '@mastra/core/request-context'
import { matchesAny } from './names.js'

/** Body One's webhook relay POSTs to a `url` action. */
export interface OneRelayEvent {
  relayEventId: string
  platform: string
  eventType?: string | null
  payload: unknown
  timestamp: string
  connectionId: string
}

export interface OneTriggerOptions {
  /** Route path, e.g. `/one/stripe`. Served under Mastra's API prefix. */
  path: string
  /** Key of the workflow registered on `new Mastra({ workflows })`. */
  workflow: string
  /** Relay signing secret. Defaults to `process.env.ONE_RELAY_SECRET`. */
  secret?: string
  /** Accept unsigned requests. Only for local testing. */
  allowUnsigned?: boolean
  /** Event-type globs to accept (e.g. `['charge.*']`). Others are acknowledged and ignored. */
  eventTypes?: string[]
  /** Maps the relay event to the workflow's input. Defaults to the event itself. */
  toInput?: (event: OneRelayEvent) => unknown
  /**
   * Request-context entries for the run, e.g. `{ userId }` for a workflow that acts per user
   * (One Connect). Use it to say which of your users an event belongs to, typically from
   * `event.connectionId`. The event is always available as `oneRelayEvent`.
   */
  requestContext?: (event: OneRelayEvent) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Window in which a repeated `relayEventId` is acknowledged without starting another run. Default 24 h. */
  dedupeWindowMs?: number
}

const DAY = 24 * 60 * 60_000

/**
 * A Mastra API route that starts a workflow for each event One's webhook relay delivers.
 *
 * ```ts
 * new Mastra({ server: { apiRoutes: [oneTrigger({ path: '/one/stripe', workflow: 'refundFlow', eventTypes: ['charge.failed'] })] } })
 * ```
 *
 * The relay signs the raw body (`X-Relay-Signature: sha256=<hex>`) but not a
 * timestamp, so repeats are dropped by `relayEventId`. Dedupe is in memory;
 * multi-instance deployments should also dedupe in the workflow.
 */
export function oneTrigger(options: OneTriggerOptions) {
  const secret = options.secret ?? process.env.ONE_RELAY_SECRET
  if (!secret && !options.allowUnsigned) {
    throw new Error('[@withone/mastra] oneTrigger needs the relay signing secret (ONE_RELAY_SECRET) or allowUnsigned: true.')
  }
  const window = options.dedupeWindowMs ?? DAY
  const seen = new Map<string, number>()

  return registerApiRoute(options.path, {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      const raw = await c.req.text()
      if (secret && !verifyRelaySignature(raw, c.req.header('x-relay-signature'), secret)) {
        return c.json({ error: 'invalid signature' }, 401)
      }

      let event: OneRelayEvent
      try {
        event = JSON.parse(raw)
      } catch {
        return c.json({ error: 'invalid JSON' }, 400)
      }
      if (!event?.relayEventId) return c.json({ error: 'missing relayEventId' }, 400)

      const eventType = event.eventType ?? c.req.header('x-relay-event-type') ?? ''
      if (options.eventTypes?.length && !matchesAny(eventType, options.eventTypes)) {
        return c.json({ ignored: true, reason: `event type "${eventType}" not handled` })
      }

      const now = Date.now()
      for (const [id, at] of seen) if (now - at > window) seen.delete(id)
      if (seen.has(event.relayEventId)) return c.json({ duplicate: true })
      seen.set(event.relayEventId, now)

      try {
        const workflow = c.get('mastra').getWorkflow(options.workflow)
        const run = await workflow.createRun()
        const extra = (await options.requestContext?.(event)) ?? {}
        const requestContext = new RequestContext<any>([...Object.entries(extra), ['oneRelayEvent', event]] as Array<[string, any]>)
        const { runId } = await run.startAsync({ inputData: (options.toInput ?? ((e) => e))(event) as any, requestContext })
        return c.json({ accepted: true, runId }, 202)
      } catch (err) {
        seen.delete(event.relayEventId)
        return c.json({ error: err instanceof Error ? err.message : 'failed to start workflow' }, 500)
      }
    },
  })
}

/** Checks `X-Relay-Signature: sha256=<hex HMAC-SHA256(raw body, secret)>` in constant time. */
export function verifyRelaySignature(rawBody: string, header: string | undefined | null, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const given = Buffer.from(header.slice('sha256='.length), 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Signs a body the way One's relay does. Useful for tests and local replays. */
export function signRelayBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}
