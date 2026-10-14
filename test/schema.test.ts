import { describe, expect, it } from 'vitest'
import { toToolInputSchema } from '../src/schema.js'
import { fillPath } from '../src/client.js'
import { matchesAny, toolIdFor, uniqueId } from '../src/names.js'

describe('toToolInputSchema', () => {
  it('drops headers, keeps path, drops an empty query', () => {
    const out = toToolInputSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        headers: {
          type: 'object',
          properties: { 'x-cal-secret-key': { type: 'string' } },
          required: ['x-cal-secret-key'],
        },
        path: {
          type: 'object',
          title: 'Path Parameters',
          properties: { eventTypeId: { type: 'string' } },
          required: ['eventTypeId'],
        },
        query: { type: 'object', properties: {}, additionalProperties: false },
      },
      required: ['path', 'headers'],
    })
    expect(out?.schema).toEqual({
      type: 'object',
      properties: {
        path: { type: 'object', properties: { eventTypeId: { type: 'string' } }, required: ['eventTypeId'] },
      },
      required: ['path'],
      additionalProperties: false,
    })
  })

  it('strips connectionKey from the body and its required list', () => {
    const out = toToolInputSchema({
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: { connectionKey: { type: 'string' }, eventTypeId: { type: 'number' } },
          required: ['connectionKey', 'eventTypeId'],
        },
      },
      required: ['body'],
    })
    expect(out?.schema.properties.body).toEqual({
      type: 'object',
      properties: { eventTypeId: { type: 'number' } },
      required: ['eventTypeId'],
    })
    expect(out?.schema.required).toEqual(['body'])
  })

  it('normalises pathVariables/queryParams aliases', () => {
    const out = toToolInputSchema({
      type: 'object',
      properties: {
        pathVariables: { type: 'object', properties: { id: { type: 'string' } } },
        queryParams: { type: 'object', properties: { limit: { type: 'integer' } } },
      },
    })
    expect(Object.keys(out!.schema.properties)).toEqual(['path', 'query'])
  })

  it('does not require a part with no required fields', () => {
    const out = toToolInputSchema({
      type: 'object',
      properties: { body: { type: 'object', properties: { connectionKey: { type: 'string' }, q: { type: 'string' } }, required: ['connectionKey'] } },
      required: ['body'],
    })
    expect(out?.schema.required).toBeUndefined()
  })

  it('returns null for unusable input', () => {
    expect(toToolInputSchema(undefined)).toBeNull()
    expect(toToolInputSchema({ type: 'string' })).toBeNull()
  })
})

describe('names', () => {
  it('builds stable snake_case tool ids', () => {
    expect(toolIdFor('cal-com', 'Get an Event Type by ID')).toBe('cal_com_get_an_event_type_by_id')
    expect(toolIdFor('gmail', 'Send Email (with attachments)')).toBe('gmail_send_email_with_attachments')
    expect(toolIdFor('1-password', "List an Item's Files")).toBe('1_password_list_an_items_files')
    expect(toolIdFor('x', 'a'.repeat(100)).length).toBeLessThanOrEqual(64)
  })

  it('dedupes collisions', () => {
    const taken = new Set(['a', 'a_2'])
    expect(uniqueId('a', taken)).toBe('a_3')
  })

  it('matches globs case-insensitively', () => {
    expect(matchesAny('gmail_send_email', ['gmail_send_*'])).toBe(true)
    expect(matchesAny('gmail_list_messages', ['gmail_send_*'])).toBe(false)
    expect(matchesAny('anything', undefined)).toBe(false)
  })
})

describe('fillPath', () => {
  it('fills {{var}} and {var} templates and encodes values', () => {
    expect(fillPath('/event-types/{{eventTypeId}}', { eventTypeId: 'a b' })).toBe('/event-types/a%20b')
    expect(fillPath('/repos/{owner}/{repo}', { owner: 'o', repo: 'r' })).toBe('/repos/o/r')
    expect(fillPath('/x/{{missing}}', {})).toBe('/x/{{missing}}')
  })
})
