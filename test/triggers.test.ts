import { describe, expect, it } from 'vitest'
import { Mastra } from '@mastra/core'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { LibSQLStore } from '@mastra/libsql'
import { z } from 'zod'
import { oneTrigger, signRelayBody, verifyRelaySignature } from '../src/triggers.js'

describe('relay signatures', () => {
  const body = '{"test":"data"}'

  it('matches an independent HMAC-SHA256 implementation', () => {
    // python3 -c "import hmac,hashlib;print(hmac.new(b'secret123', b'{\"test\":\"data\"}', hashlib.sha256).hexdigest())"
    expect(signRelayBody(body, 'secret123')).toBe('sha256=e3439068a46bd1089b019ec14dd865e9fb3e4f643f3489804173e04ed34ab609')
  })

  it('verifies only the exact body, secret and scheme', () => {
    const sig = signRelayBody(body, 'secret123')
    expect(verifyRelaySignature(body, sig, 'secret123')).toBe(true)
    expect(verifyRelaySignature(`${body} `, sig, 'secret123')).toBe(false)
    expect(verifyRelaySignature(body, sig, 'other')).toBe(false)
    expect(verifyRelaySignature(body, sig.replace('sha256=', ''), 'secret123')).toBe(false)
    expect(verifyRelaySignature(body, 'sha256=zz', 'secret123')).toBe(false)
    expect(verifyRelaySignature(body, undefined, 'secret123')).toBe(false)
  })
})

describe('oneTrigger', () => {
  it('refuses to build an unsigned route unless asked to', () => {
    const prev = process.env.ONE_RELAY_SECRET
    delete process.env.ONE_RELAY_SECRET
    expect(() => oneTrigger({ path: '/one/x', workflow: 'w' })).toThrow(/ONE_RELAY_SECRET/)
    expect(() => oneTrigger({ path: '/one/x', workflow: 'w', allowUnsigned: true })).not.toThrow()
    if (prev) process.env.ONE_RELAY_SECRET = prev
  })

  it('registers a public POST route', () => {
    const route: any = oneTrigger({ path: '/one/stripe', workflow: 'w', secret: 's' })
    expect(route).toMatchObject({ path: '/one/stripe', method: 'POST', requiresAuth: false })
  })

  it('starts the workflow with the request context the app maps from the event (e.g. which user)', async () => {
    const seen: Array<{ userId: unknown; eventType: unknown }> = []
    const record = createStep({
      id: 'record',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({ requestContext }) => {
        seen.push({ userId: requestContext.get('userId'), eventType: (requestContext.get('oneRelayEvent') as any)?.eventType })
        return {}
      },
    })
    const wf = createWorkflow({ id: 'w', inputSchema: z.any(), outputSchema: z.any() }).then(record).commit()
    const mastra = new Mastra({ workflows: { w: wf }, storage: new LibSQLStore({ id: 't', url: ':memory:' }), logger: false })
    const route: any = oneTrigger({
      path: '/one/linear',
      workflow: 'w',
      secret: 's',
      requestContext: (event) => ({ userId: event.connectionId === 'conn-1' ? 'alice' : undefined }),
    })
    const body = JSON.stringify({
      relayEventId: 'e1',
      platform: 'linear',
      eventType: 'Issue',
      payload: {},
      timestamp: 't',
      connectionId: 'conn-1',
    })
    const c = {
      req: { text: async () => body, header: (n: string) => (n === 'x-relay-signature' ? signRelayBody(body, 's') : undefined) },
      json: (b: unknown, status = 200) => ({ b, status }),
      get: (k: string) => (k === 'mastra' ? mastra : undefined),
    }
    const res = await route.handler(c)
    expect(res).toMatchObject({ status: 202, b: { accepted: true } })
    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]).toEqual({ userId: 'alice', eventType: 'Issue' })
  })
})
