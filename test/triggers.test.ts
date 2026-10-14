import { describe, expect, it } from 'vitest'
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
})
