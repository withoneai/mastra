import { describe, expect, it } from 'vitest'
import { Mastra } from '@mastra/core'
import { createWorkflow } from '@mastra/core/workflows'
import { LibSQLStore } from '@mastra/libsql'
import { oneStep } from '../src/workflows.js'

function fakeOne(passthroughStatus = 200) {
  const calls: Array<{ url: URL; body?: string }> = []
  const actions = [
    { systemId: 'conn_mod_def::refund', title: 'Create a Refund', key: 'k', method: 'POST', path: '/v1/refunds', tags: [] },
    { systemId: 'conn_mod_def::post', title: 'Post Message', key: 'k2', method: 'POST', path: '/chat.postMessage', tags: [] },
  ]
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, body: init?.body as string | undefined })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const p = url.pathname
    if (p === '/v1/vault/connections') {
      const platform = url.searchParams.get('platform')!
      return json({ rows: [{ key: `test::${platform}::default::1`, platform, state: 'operational', active: true }], pages: 1 })
    }
    if (p.startsWith('/v1/available-actions/')) {
      const platform = p.split('/').pop()
      return json({ rows: platform === 'stripe' ? [actions[0]] : [actions[1]], pages: 1, total: 1 })
    }
    if (p === '/v1/knowledge') {
      const a = actions.find((x) => x.systemId === url.searchParams.get('_id'))!
      return json({
        rows: [{ ...a, _id: a.systemId, ioSchema: { inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { amount: { type: 'number' }, text: { type: 'string' } } } } } } }],
      })
    }
    if (p.startsWith('/v1/passthrough/')) return json(passthroughStatus === 200 ? { id: 're_1' } : { error: 'nope' }, passthroughStatus)
    return json({}, 404)
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function refundFlow(fake: ReturnType<typeof fakeOne>, opts: { requireApproval?: boolean; onDecline?: 'stop' | 'continue' } = {}) {
  const refund = await oneStep({ platform: 'stripe', action: 'stripe_create_a_refund', secret: 'sk_test', fetch: fake.fetchImpl, ...opts })
  const notify = await oneStep({ platform: 'slack', action: 'Post Message', secret: 'sk_test', fetch: fake.fetchImpl })
  const workflow = createWorkflow({
    id: 'refund',
    inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } as any,
    outputSchema: {} as any,
  })
    .map(async ({ inputData }: any) => ({ body: { amount: inputData.amount } }))
    .then(refund)
    .map(async () => ({ body: { text: 'refunded' } }))
    .then(notify)
    .commit()
  const mastra = new Mastra({ workflows: { workflow }, storage: new LibSQLStore({ id: 't', url: ':memory:' }), logger: false })
  return { wf: mastra.getWorkflow('workflow'), refund, notify }
}

const passthroughPaths = (fake: ReturnType<typeof fakeOne>) =>
  fake.calls.filter((c) => c.url.pathname.startsWith('/v1/passthrough/')).map((c) => c.url.pathname)

describe('oneStep', () => {
  it('runs One actions as typed workflow steps', async () => {
    const fake = fakeOne()
    const { wf, refund } = await refundFlow(fake)
    expect(refund.id).toBe('stripe_create_a_refund')
    const res: any = await (await wf.createRun()).start({ inputData: { amount: 5 } })
    expect(res.status).toBe('success')
    expect(passthroughPaths(fake)).toEqual(['/v1/passthrough/v1/refunds', '/v1/passthrough/chat.postMessage'])
    expect(JSON.parse(fake.calls.find((c) => c.url.pathname === '/v1/passthrough/v1/refunds')!.body!)).toEqual({ amount: 5 })
  })

  it('suspends for approval and runs after approval', async () => {
    const fake = fakeOne()
    const { wf, refund } = await refundFlow(fake, { requireApproval: true })
    const run = await wf.createRun()
    const started: any = await run.start({ inputData: { amount: 5 } })
    expect(started.status).toBe('suspended')
    expect(passthroughPaths(fake)).toEqual([])
    const resumed: any = await run.resume({ step: refund, resumeData: { approved: true } })
    expect(resumed.status).toBe('success')
    expect(passthroughPaths(fake)).toHaveLength(2)
  })

  it('stops the workflow when approval is declined', async () => {
    const fake = fakeOne()
    const { wf, refund } = await refundFlow(fake, { requireApproval: true })
    const run = await wf.createRun()
    await run.start({ inputData: { amount: 5 } })
    const resumed: any = await run.resume({ step: refund, resumeData: { approved: false } })
    expect(resumed.result).toMatchObject({ declined: true })
    expect(passthroughPaths(fake)).toEqual([])
  })

  it('can pass a declined result on instead', async () => {
    const fake = fakeOne()
    const { wf, refund } = await refundFlow(fake, { requireApproval: true, onDecline: 'continue' })
    const run = await wf.createRun()
    await run.start({ inputData: { amount: 5 } })
    await run.resume({ step: refund, resumeData: { approved: false } })
    expect(passthroughPaths(fake)).toEqual(['/v1/passthrough/chat.postMessage'])
  })

  it('fails the step on a non-2xx response', async () => {
    const fake = fakeOne(402)
    const { wf } = await refundFlow(fake)
    const res: any = await (await wf.createRun()).start({ inputData: { amount: 5 } })
    expect(res.status).toBe('failed')
    expect(String(res.error?.message ?? res.error)).toMatch(/Create a Refund failed with 402/)
    expect(passthroughPaths(fake)).toEqual(['/v1/passthrough/v1/refunds'])
  })

  it('rejects an unknown action at definition time', async () => {
    const fake = fakeOne()
    await expect(oneStep({ platform: 'stripe', action: 'nope', secret: 'sk_test', fetch: fake.fetchImpl })).rejects.toThrow(/no "stripe" action matches "nope"/)
  })
})
