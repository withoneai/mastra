#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_BASE_URL, OneClient } from './client.js'
import { patchMastraIndex } from './init/patch.js'
import { agentFile } from './init/templates.js'

const HELP = `Usage: withone-mastra init [dir] [options]

Wires One into a Mastra project: an agent with your connected apps as tools,
One in Mastra Studio's tool picker, and ONE_SECRET in .env. Creates the
project with create-mastra first if [dir] has none.

Options:
  --platforms <list>    Comma-separated One platform slugs (default: pick interactively)
  --secret <key>        One secret key (default: ONE_SECRET, then your One CLI login)
  --base-url <url>      One API base (default: ONE_BASE_URL or ${DEFAULT_BASE_URL})
  --llm <provider>      Model provider for a new project (default: anthropic)
  --package <spec>      How to install @withone/mastra (default: @withone/mastra@latest)
  --no-install          Write files only
  -y, --yes             Accept defaults without prompting
  -h, --help            Show this help
`

interface Ctx {
  dir: string
  secret: string
  baseUrl: string
  platforms: string[]
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      platforms: { type: 'string' },
      secret: { type: 'string' },
      'base-url': { type: 'string' },
      llm: { type: 'string', default: 'anthropic' },
      package: { type: 'string', default: '@withone/mastra@latest' },
      'no-install': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, target] = positionals
  if (values.help || command !== 'init') {
    process.stdout.write(HELP)
    process.exit(values.help ? 0 : 1)
  }

  const interactive = process.stdin.isTTY && !values.yes
  const dir = resolve(target ?? '.')
  const step = (msg: string) => process.stdout.write(`✓ ${msg}\n`)

  // 1. One credentials, reusing the One CLI's login when there is one.
  const cli = readOneCliConfig()
  const secret = values.secret ?? process.env.ONE_SECRET ?? cli?.apiKey
  const baseUrl = (values['base-url'] ?? process.env.ONE_BASE_URL ?? cli?.apiBase ?? DEFAULT_BASE_URL).replace(/\/v1\/?$/, '')
  if (!secret) fail('No One key found. Run `one login`, set ONE_SECRET, or pass --secret.')
  const client = new OneClient({ secret, baseUrl })
  const me = await client.whoami().catch((err) => fail(`One rejected the key at ${baseUrl}: ${err.message}`))
  step(`Signed in to One as ${(me as any)?.user?.email ?? 'your account'} (${client.environment}, ${baseUrl})`)

  // 2. Which apps the agent gets.
  const connections = await client.listConnections()
  const connected = [...new Set(connections.filter((c) => c.state === 'operational' && c.active !== false).map((c) => c.platform))].sort()
  step(`Found ${connections.length} connections across ${connected.length} apps`)
  let platforms = values.platforms
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!platforms) {
    if (!interactive) fail('Pass --platforms (e.g. --platforms gmail,slack) when not running interactively.')
    platforms = await askPlatforms(connected)
  }
  const missing = platforms.filter((p) => !connected.includes(p))
  if (missing.length)
    process.stdout.write(`  note: not connected yet: ${missing.join(', ')}; the agent will offer a connect link for them\n`)

  // 3. A Mastra project to put it in.
  if (!existsSync(join(dir, 'src/mastra/index.ts'))) {
    if (interactive && !(await confirm(`No Mastra project in ${dir}. Create one with create-mastra?`))) fail('Nothing to do.')
    const parent = dirname(dir)
    mkdirSync(parent, { recursive: true })
    run(
      'npx',
      ['-y', 'create-mastra@latest', dir.slice(parent.length + 1), '-l', values.llm!, '--no-git', '--no-install', '--no-skills'],
      parent,
    )
    step('Created a Mastra project with create-mastra')
  }

  const ctx: Ctx = { dir, secret, baseUrl, platforms }
  writeAgent(ctx)
  step('Wrote src/mastra/agents/one-agent.ts')

  const patch = patchMastraIndex(readFileSync(join(dir, 'src/mastra/index.ts'), 'utf8'))
  writeFileSync(join(dir, 'src/mastra/index.ts'), patch.source)
  step(`Updated src/mastra/index.ts (${patch.changes.join(', ') || 'already set up'})`)
  for (const note of patch.manual) process.stdout.write(`  manual step: ${note}\n`)

  writeEnv(ctx)
  step('Added ONE_SECRET to .env')

  installSkill(dir)
  step('Installed the one-mastra skill for coding agents (.agents/skills, .claude/skills)')

  if (!values['no-install']) {
    const pm = packageManager(dir)
    run(pm, [pm === 'npm' ? 'install' : 'add', values.package!, '@mastra/editor@latest'], dir)
    step(`Installed @withone/mastra and @mastra/editor with ${pm}`)
  }

  process.stdout.write(
    `\nNext:\n  cd ${dir}\n  npm run dev        # Studio at http://localhost:4111 — open the "One agent", or add One tools to any agent in the editor\n`,
  )
}

function writeAgent(ctx: Ctx) {
  const file = join(ctx.dir, 'src/mastra/agents/one-agent.ts')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, agentFile(ctx.platforms))
}

function writeEnv(ctx: Ctx) {
  const file = join(ctx.dir, '.env')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines: string[] = []
  if (!/^ONE_SECRET=/m.test(current)) lines.push(`ONE_SECRET=${ctx.secret}`)
  if (ctx.baseUrl !== DEFAULT_BASE_URL && !/^ONE_BASE_URL=/m.test(current)) lines.push(`ONE_BASE_URL=${ctx.baseUrl}`)
  if (lines.length) writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`)

  const ignore = join(ctx.dir, '.gitignore')
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  if (!/^\.env$/m.test(ignored)) writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}.env\n`)
}

function installSkill(dir: string) {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'one-mastra')
  if (!existsSync(source)) return
  for (const target of ['.agents/skills/one-mastra', '.claude/skills/one-mastra']) {
    cpSync(source, join(dir, target), { recursive: true })
  }
}

function readOneCliConfig(): { apiKey?: string; apiBase?: string } | undefined {
  const file = join(process.env.ONE_HOME ?? join(homedir(), '.one'), 'config.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

function run(cmd: string, args: string[], cwd: string) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} failed`)
}

async function askPlatforms(connected: string[]): Promise<string[]> {
  process.stdout.write(`\nConnected apps:\n${connected.map((p) => `  ${p}`).join('\n')}\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('Apps for the agent (comma-separated): ')
  rl.close()
  const picked = answer
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!picked.length) fail('No apps chosen.')
  return picked
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} (Y/n) `)
  rl.close()
  return !/^n/i.test(answer.trim())
}

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)))
