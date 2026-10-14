import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { LibSQLStore } from '@mastra/libsql'
import { OneToolProvider } from '@withone/mastra/provider'
import { oneTrigger } from '@withone/mastra/triggers'
import { opsAgent } from './agents/ops'
import { issueDigest } from './workflows/issue-digest'

export const mastra = new Mastra({
  agents: { opsAgent },
  workflows: { issueDigest },
  server: {
    apiRoutes: [oneTrigger({ path: '/one/events', workflow: 'issueDigest', eventTypes: ['charge.*', 'issue.*'] })],
  },
  storage: new LibSQLStore({ id: 'studio-example', url: 'file:./mastra.db' }),
  editor: new MastraEditor({
    toolProviders: {
      one: new OneToolProvider({ requireApproval: ['*_create_*', '*_delete_*', '*_update_*'] }),
    },
  }),
})
