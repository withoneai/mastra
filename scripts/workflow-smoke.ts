// Live, read-only check of oneStep inside a real Mastra workflow, including suspend → approve → resume.
import { Mastra } from '@mastra/core'
import { createWorkflow } from '@mastra/core/workflows'
import { LibSQLStore } from '@mastra/libsql'
import { oneStep } from '../src/workflows.js'

const listIssues = await oneStep({ platform: 'linear', action: 'linear_list_issues', requireApproval: true })
const profile = await oneStep({ platform: 'cal-com', action: 'Get My Profile' })

const workflow = createWorkflow({
  id: 'one-smoke',
  inputSchema: { type: 'object', properties: { first: { type: 'number' } }, required: ['first'] } as any,
  outputSchema: { type: 'object', properties: { issues: {}, email: {} } } as any,
})
  .map(async ({ inputData }: any) => ({
    body: { query: 'query($first: Int) { issues(first: $first) { nodes { identifier title } } }', variables: { first: inputData.first } },
  }))
  .then(listIssues)
  .map(async () => ({}))
  .then(profile)
  .map(async ({ getStepResult }: any) => ({
    issues: getStepResult(listIssues).data?.data?.issues?.nodes,
    email: getStepResult(profile).data?.data?.email,
  }))
  .commit()

const mastra = new Mastra({ workflows: { workflow }, storage: new LibSQLStore({ id: 'smoke', url: ':memory:' }) })
const wf = mastra.getWorkflow('workflow')

const run = await wf.createRun()
const first = await run.start({ inputData: { first: 2 } })
console.log('start →', first.status, JSON.stringify((first as any).suspendPayload ?? (first as any).suspended ?? ''))

const resumed = await run.resume({ step: listIssues, resumeData: { approved: true } })
console.log('resume(approved) →', resumed.status, JSON.stringify((resumed as any).result ?? (resumed as any).error))

const declinedRun = await wf.createRun()
await declinedRun.start({ inputData: { first: 1 } })
const declined = await declinedRun.resume({ step: listIssues, resumeData: { approved: false, note: 'not now' } })
console.log('resume(declined) →', declined.status, 'result:', JSON.stringify((declined as any).result), '| profile step ran:', Boolean((declined as any).steps?.[profile.id]))
