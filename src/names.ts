const MAX_TOOL_ID = 64

/** `cal-com` + "Get an Event Type by ID" → `cal_com_get_an_event_type_by_id`. */
export function toolIdFor(platform: string, title: string): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/['’]/g, '')
      .replace(/[^\w\s-]/g, ' ')
      .trim()
      .replace(/[\s-]+/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase()
  return `${slug(platform)}_${slug(title)}`.slice(0, MAX_TOOL_ID).replace(/_+$/, '')
}

/** Appends `_2`, `_3`… so two actions with the same title never collide. */
export function uniqueId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const candidate = `${id.slice(0, MAX_TOOL_ID - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Minimal glob: `*` matches any run of characters. Case-insensitive. */
export function matchesAny(value: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length) return false
  return patterns.some((p) => globToRegExp(p).test(value))
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

const WRITE_VERBS =
  /\b(send|create|update|delete|remove|modify|trash|untrash|batch|insert|patch|set|archive|forward|reply|move|stop|watch|import|upload|post|add|invite|kick|cancel|refund|charge|pay|void|publish|assign|merge|close|reopen|star|unstar|mark)\b/i
const READ_VERBS = /\b(list|get|search|fetch|view|read|retrieve|find|lookup|query|count|check|describe|show|download|export)\b/i

/**
 * Whether running an action changes data. GET and HEAD never do; PUT, PATCH and DELETE always do.
 * POST is ambiguous (GraphQL reads, Slack's Web API, One's own actions), so its title decides:
 * "List Issues" reads, "Create Issue" writes, and an unrecognised title counts as a write.
 * (From withoneai/mastra.)
 */
export function isWriteAction(action: { method: string; title: string }): boolean {
  const method = action.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return false
  if (method !== 'POST') return true
  if (WRITE_VERBS.test(action.title)) return true
  return !READ_VERBS.test(action.title)
}

/** An approval setting: `true` for everything, `'writes'` for actions that change data, or tool-id globs. */
export type ApprovalRule = boolean | 'writes' | string[]

export function approvalNeeded(rule: ApprovalRule | undefined, toolId: string, action: { method: string; title: string }): boolean {
  if (rule === true) return true
  if (rule === 'writes') return isWriteAction(action)
  return Array.isArray(rule) && matchesAny(toolId, rule)
}
