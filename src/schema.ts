type Json = Record<string, any>

export type JsonSchema = Record<string, any>

/** Input parts the model fills in. Headers are never exposed: One injects auth and the definition carries the rest. */
export type InputPart = 'path' | 'query' | 'body'

const PART_ALIASES: Record<string, InputPart> = {
  path: 'path',
  pathVariables: 'path',
  pathParams: 'path',
  query: 'query',
  queryParams: 'query',
  body: 'body',
  data: 'body',
}

/** Body fields One fills itself; showing them to the model invites it to invent credentials. */
const INJECTED_FIELDS = new Set(['connectionKey', 'connection_key'])

export interface ToolInputSchema {
  schema: JsonSchema
  parts: Partial<Record<InputPart, string>>
}

export const OPEN_INPUT_SCHEMA: ToolInputSchema = {
  schema: {
    type: 'object',
    properties: {
      path: { type: 'object', description: 'Path parameters, by name.', additionalProperties: true },
      query: { type: 'object', description: 'Query-string parameters.', additionalProperties: true },
      body: { description: 'Request body (JSON).' },
    },
    additionalProperties: false,
  },
  parts: { path: 'path', query: 'query', body: 'body' },
}

/**
 * Turns One's per-action `ioSchema.inputSchema` into a tool input schema:
 * drops headers and credential fields, normalises part names, and removes
 * parts with nothing for the model to fill. Returns null if the schema isn't
 * the expected `{ path?, query?, body? }` object.
 */
export function toToolInputSchema(input: unknown): ToolInputSchema | null {
  if (!isObj(input) || !isObj(input.properties)) return null

  const properties: Json = {}
  const required: string[] = []
  const parts: ToolInputSchema['parts'] = {}
  const sourceRequired = new Set<string>(Array.isArray(input.required) ? input.required : [])

  for (const [sourceName, raw] of Object.entries(input.properties as Json)) {
    const part = PART_ALIASES[sourceName]
    if (!part || !isObj(raw)) continue

    const cleaned = part === 'body' ? stripInjected(raw) : stripSchemaNoise(raw)
    if (isEmptyObjectSchema(cleaned)) continue

    properties[part] = cleaned
    parts[part] = sourceName
    if (sourceRequired.has(sourceName) && hasRequiredContent(cleaned)) required.push(part)
  }

  const schema: JsonSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
  }
  if (required.length) schema.required = required
  return { schema, parts }
}

function stripInjected(schema: Json): Json {
  const out = stripSchemaNoise(schema)
  if (!isObj(out.properties)) return out
  const props: Json = {}
  for (const [k, v] of Object.entries(out.properties as Json)) {
    if (INJECTED_FIELDS.has(k)) continue
    props[k] = v
  }
  out.properties = props
  if (Array.isArray(out.required)) out.required = out.required.filter((r: string) => r in props)
  if (Array.isArray(out.required) && out.required.length === 0) delete out.required
  return out
}

function stripSchemaNoise(schema: Json): Json {
  const { $schema, title, ...rest } = schema
  return rest
}

function isEmptyObjectSchema(s: Json): boolean {
  const isObjectType = s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))
  return isObjectType && (!isObj(s.properties) || Object.keys(s.properties).length === 0) && s.additionalProperties !== true
}

function hasRequiredContent(s: Json): boolean {
  if (s.type !== 'object') return true
  return Array.isArray(s.required) && s.required.length > 0
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
