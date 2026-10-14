import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { LibSQLStore } from '@mastra/libsql'
import { OneToolProvider } from '@withone/mastra/provider'
import { opsAgent } from './agents/ops'

export const mastra = new Mastra({
  agents: { opsAgent },
  storage: new LibSQLStore({ id: 'studio-example', url: 'file:./mastra.db' }),
  editor: new MastraEditor({
    toolProviders: {
      one: new OneToolProvider({ requireApproval: ['*_create_*', '*_delete_*', '*_update_*'] }),
    },
  }),
})
