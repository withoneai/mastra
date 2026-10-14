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
