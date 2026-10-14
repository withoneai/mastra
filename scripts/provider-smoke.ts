// Live, read-only check of OneToolProvider against a real One account.
import { OneToolProvider } from '../src/provider.js'

const provider = new OneToolProvider()
const t = async <T>(label: string, fn: () => Promise<T>) => {
  const start = Date.now()
  const out = await fn()
  console.log(`${label} (${Date.now() - start} ms)`)
  return out
}

console.log('health', await provider.getHealth())
const toolkits = await t('listToolkitsVNext', () => provider.listToolkitsVNext())
console.log(
  ' ',
  toolkits.data.length,
  'toolkits; e.g.',
  toolkits.data.slice(0, 3).map((k) => k.slug),
)

const page1 = await t('listToolsVNext(cal-com)', () => provider.listToolsVNext({ toolkit: 'cal-com', perPage: 5 }))
console.log(
  ' ',
  page1.data.map((d) => d.slug),
  page1.pagination,
)
const search = await t('listToolsVNext(linear, "list issues")', () =>
  provider.listToolsVNext({ toolkit: 'linear', search: 'list issues', perPage: 5 }),
)
console.log(
  ' ',
  search.data.map((d) => d.slug),
)

const conns = await t('listConnections(linear)', () => provider.listConnections({ toolkit: 'linear', perPage: 3 }))
console.log(' ', conns.items, conns.pagination)
const key = conns.items.find((c) => c.status === 'active')!.connectionId

console.log(
  'getConnectionStatus',
  await provider.getConnectionStatus({
    items: [
      { connectionId: key, toolkit: 'linear' },
      { connectionId: 'test::linear::default::nope', toolkit: 'linear' },
    ],
  }),
)
console.log('schema', JSON.stringify(await provider.getToolSchema('linear_list_issues')).slice(0, 200))

const tools = await t('resolveToolsVNext(linear_list_issues)', () =>
  provider.resolveToolsVNext({
    toolSlugs: ['linear_list_issues'],
    toolMeta: { linear_list_issues: { toolkit: 'linear' } },
    connectionId: key,
    toolkit: 'linear',
  }),
)
const res: any = await tools.linear_list_issues!.execute!(
  { body: { query: 'query($first: Int) { issues(first: $first) { nodes { identifier title } } }', variables: { first: 2 } } } as any,
  {} as any,
)
console.log('  execute →', res.status, JSON.stringify(res.data ?? res).slice(0, 600))

const auth = await provider.authorize({ toolkit: 'linear', connectionId: 'default' })
console.log('authorize', auth)
console.log('getAuthStatus (nothing connected yet)', await provider.getAuthStatus(auth.authId))
console.log('getAuthStatus (unknown id)', await provider.getAuthStatus('oneauth_unknown'))
