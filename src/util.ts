/** In-memory cache that also shares in-flight loads, so concurrent requests fetch once. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>()

  constructor(private readonly ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    const value = load()
    this.entries.set(key, { at: Date.now(), value })
    value.catch(() => this.entries.delete(key))
    return value
  }
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
