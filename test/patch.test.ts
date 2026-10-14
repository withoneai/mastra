import { describe, expect, it } from 'vitest'
import { patchMastraIndex } from '../src/init/patch.js'
import { agentFile } from '../src/init/templates.js'

const CREATE_MASTRA = `import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  Observability,
} from '@mastra/observability';
import { agent } from './agents/agent';

export const mastra = new Mastra({
  agents: { agent },
  storage: new LibSQLStore({ id: 'mastra-storage', url: 'file:./mastra.db' }),
});
`

describe('patchMastraIndex', () => {
  it('adds imports, the agent and the Studio provider to a create-mastra project', () => {
    const { source, changes, manual } = patchMastraIndex(CREATE_MASTRA)
    expect(changes).toEqual(['imports', 'agent', 'Studio provider'])
    expect(manual).toEqual([])
    expect(source).toContain("import { agent } from './agents/agent';\nimport { MastraEditor } from '@mastra/editor';")
    expect(source).toContain("import { oneAgent } from './agents/one-agent';")
    expect(source).toContain('agents: { oneAgent, agent }')
    expect(source).toContain('editor: new MastraEditor({ toolProviders: { one: new OneToolProvider() } }),')
  })

  it('is idempotent', () => {
    const once = patchMastraIndex(CREATE_MASTRA).source
    const twice = patchMastraIndex(once)
    expect(twice.source).toBe(once)
    expect(twice.changes).toEqual([])
  })

  it('adds an agents map when there is none, and flags missing storage', () => {
    const { source, manual } = patchMastraIndex(`import { Mastra } from '@mastra/core';\nexport const mastra = new Mastra({});\n`)
    expect(source).toContain('agents: { oneAgent },')
    expect(manual[0]).toMatch(/storage/)
  })

  it('leaves an existing editor alone and says what to add', () => {
    const { source, manual } = patchMastraIndex(
      `import { Mastra } from '@mastra/core';\nimport { MastraEditor } from '@mastra/editor';\nexport const mastra = new Mastra({ storage, editor: new MastraEditor({}) });\n`,
    )
    expect(source.match(/editor:/g)).toHaveLength(1)
    expect(manual[0]).toMatch(/toolProviders/)
  })

  it('gives up cleanly on a file without new Mastra', () => {
    const { source, manual } = patchMastraIndex('export const x = 1\n')
    expect(source).toBe('export const x = 1\n')
    expect(manual[0]).toMatch(/oneAgent/)
  })
})

describe('agentFile', () => {
  it('quotes slugs that are not identifiers', () => {
    const file = agentFile(['gmail', 'google-calendar'])
    expect(file).toContain("      gmail: true,\n      'google-calendar': true,")
  })
})
