// Live check against a real One account. Read-only actions only.
//   ONE_SECRET=sk_test_… [ONE_BASE_URL=…] pnpm smoke
import { Agent } from '@mastra/core/agent'
import { oneTools } from '../src/index.js'

const resolve = oneTools({
  platforms: {
    'cal-com': { allowTools: ['cal_com_get_my_profile*', 'cal_com_get_event_types', 'cal_com_get_schedules*'] },
    linear: true,
  },
})

const started = Date.now()
const tools = (await resolve()) as Record<string, any>
console.log(`resolved ${Object.keys(tools).length} tools in ${Date.now() - started} ms:`, Object.keys(tools))

const again = Date.now()
await resolve()
console.log(`cached resolve: ${Date.now() - again} ms`)

const typed = Object.keys(tools).find((id) => id.startsWith('cal_com_'))
if (typed) {
  console.log(`\n${typed} schema:`, JSON.stringify(tools[typed].inputSchema).slice(0, 400))
  const res = await tools[typed].execute({}, {})
  console.log(`${typed} →`, res.status, JSON.stringify(res.data).slice(0, 300))
}

const found = await tools.one_find_actions.execute({ platform: 'linear', query: 'list issues' }, {})
console.log('\none_find_actions(linear, "list issues") →', found.slice(0, 3))
const listIssues = found.find((a: any) => a.title === 'List Issues') ?? found[0]
const doc = await tools.one_get_action.execute({ actionId: listIssues.actionId }, {})
console.log('one_get_action →', doc.title, Object.keys(doc.inputSchema?.properties ?? {}))
const ran = await tools.one_run_action.execute(
  {
    actionId: listIssues.actionId,
    body: { query: 'query { issues(first: 2) { nodes { identifier title } } }' },
  },
  {},
)
console.log('one_run_action →', ran.status, JSON.stringify(ran.data).slice(0, 300))

// Mastra accepts the resolver as an agent's dynamic `tools`.
const agent = new Agent({ id: 'smoke', name: 'smoke', instructions: 'test', model: 'anthropic/claude-sonnet-5-5', tools: resolve })
const listed = await agent.listTools()
console.log('\nagent.listTools() →', Object.keys(listed).length, 'tools')
