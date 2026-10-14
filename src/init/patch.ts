export interface PatchResult {
  source: string
  changes: string[]
  /** Steps the patcher could not do safely, for the user to finish by hand. */
  manual: string[]
}

const IMPORTS: Array<[name: string, line: string]> = [
  ['MastraEditor', "import { MastraEditor } from '@mastra/editor';"],
  ['OneToolProvider', "import { OneToolProvider } from '@withone/mastra/provider';"],
  ['oneAgent', "import { oneAgent } from './agents/one-agent';"],
]

/**
 * Registers the One agent and Studio provider in a project's `src/mastra/index.ts`.
 * Text-based and idempotent; anything it can't place safely is reported in `manual`.
 */
export function patchMastraIndex(input: string): PatchResult {
  let source = input
  const changes: string[] = []
  const manual: string[] = []

  const ctor = source.match(/new\s+Mastra\s*\(\s*\{/)
  if (!ctor || ctor.index === undefined) {
    return {
      source,
      changes,
      manual: [
        'add `oneAgent` to your Mastra agents and `editor: new MastraEditor({ toolProviders: { one: new OneToolProvider() } })` to `new Mastra({ … })`',
      ],
    }
  }

  const missingImports = IMPORTS.filter(([name]) => !new RegExp(`import\\s[^;]*\\b${name}\\b`).test(source)).map(([, line]) => line)
  if (missingImports.length) {
    const lastImport = [...source.matchAll(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm)].at(-1)
    const at = lastImport ? lastImport.index! + lastImport[0].length : 0
    source = `${source.slice(0, at)}${at ? '\n' : ''}${missingImports.join('\n')}${at ? '' : '\n'}${source.slice(at)}`
    changes.push('imports')
  }

  const insertAfterCtor = (text: string) => {
    const m = source.match(/new\s+Mastra\s*\(\s*\{/)!
    const at = m.index! + m[0].length
    source = `${source.slice(0, at)}\n  ${text}${source.slice(at)}`
  }

  if (!/\boneAgent\b[^;]*$/m.test(source.slice(source.search(/new\s+Mastra\s*\(/)))) {
    const agents = source.match(/\bagents\s*:\s*\{/)
    if (agents && agents.index !== undefined) {
      const at = agents.index + agents[0].length
      source = `${source.slice(0, at)} oneAgent,${source.slice(at)}`
    } else {
      insertAfterCtor('agents: { oneAgent },')
    }
    changes.push('agent')
  }

  if (!/\beditor\s*:/.test(source)) {
    insertAfterCtor('editor: new MastraEditor({ toolProviders: { one: new OneToolProvider() } }),')
    changes.push('Studio provider')
  } else if (!/new\s+OneToolProvider\s*\(/.test(source)) {
    manual.push('add `one: new OneToolProvider()` to the `toolProviders` of your existing MastraEditor')
  }

  if (!/\bstorage\s*:/.test(source)) {
    manual.push(
      "Studio's editor stores connections, so give Mastra a `storage` (e.g. `new LibSQLStore({ id: 'mastra', url: 'file:./mastra.db' })`)",
    )
  }

  return { source, changes, manual }
}
