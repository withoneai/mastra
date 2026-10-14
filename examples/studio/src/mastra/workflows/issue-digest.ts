import { createWorkflow } from '@mastra/core/workflows'
import { oneStep } from '@withone/mastra/workflows'

// Triggered by a One relay event; looks up the latest Linear issues (read-only).
const listIssues = await oneStep({ platform: 'linear', action: 'linear_list_issues' })

export const issueDigest = createWorkflow({
  id: 'issue-digest',
  inputSchema: { type: 'object', properties: { eventType: {}, payload: {} } } as any,
  outputSchema: { type: 'object', properties: { trigger: {}, issues: {} } } as any,
})
  .map(async () => ({
    body: { query: 'query($first: Int) { issues(first: $first) { nodes { identifier title } } }', variables: { first: 3 } },
  }))
  .then(listIssues)
  .map(async ({ getInitData, getStepResult }: any) => ({
    trigger: getInitData().eventType,
    issues: getStepResult(listIssues).data?.data?.issues?.nodes,
  }))
  .commit()
