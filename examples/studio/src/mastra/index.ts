import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { LibSQLStore } from '@mastra/libsql'
import { OneToolProvider } from '@withone/mastra/provider'
import { oneTrigger } from '@withone/mastra/triggers'
import { opsAgent } from './agents/ops'
import { personalAgent } from './agents/personal'
import { oneConnectRoutes } from './one-connect'
import { issueDigest } from './workflows/issue-digest'

export const mastra = new Mastra({
  agents: { opsAgent, ...(personalAgent ? { personalAgent } : {}) },
  workflows: { issueDigest },
  server: {
    port: Number(process.env.PORT) || 4111,
    apiRoutes: [
      oneTrigger({ path: '/one/events', workflow: 'issueDigest', eventTypes: ['charge.*', 'issue.*'] }),
      ...oneConnectRoutes,
    ],
  },
  storage: new LibSQLStore({ id: 'studio-example', url: 'file:./mastra.db' }),
  editor: new MastraEditor({
    toolProviders: {
      one: new OneToolProvider({ requireApproval: ['*_create_*', '*_delete_*', '*_update_*'] }),
    },
  }),
})
