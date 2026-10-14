// Ask an agent with every app you've connected on One a question, from the terminal:
//
//   npx tsx examples/agent.ts "What are my Gmail labels?"
//
// Reads .env: ONE_SECRET, plus OPENAI_API_KEY or ANTHROPIC_API_KEY (MODEL overrides the model).
import { existsSync } from 'node:fs'
import { Agent } from '@mastra/core/agent'
import { oneTools } from '../src/index.js'

if (existsSync('.env')) process.loadEnvFile('.env')

if (!process.env.ONE_SECRET) exit('Set ONE_SECRET in .env to your One API key.')
if (!process.env.MODEL && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY)
  exit('Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env (and MODEL to pick another provider).')

const question = process.argv.slice(2).join(' ') || 'Which apps do I have connected, and what is one useful thing you could do in each?'
const model = process.env.MODEL ?? (process.env.OPENAI_API_KEY ? 'openai/gpt-5.5' : 'anthropic/claude-sonnet-5-5')

const agent = new Agent({
  id: 'one-example',
  name: 'One example',
  instructions: 'Answer from the user’s connected apps. Use the tools; never invent data. Be brief.',
  model,
  defaultOptions: { maxSteps: 15 },
  tools: oneTools(),
})

const reply = await agent.generate(question)
for (const step of reply.steps) for (const call of step.toolCalls) console.log(`  · ${call.payload.toolName}`)
console.log(`\n${reply.text}`)

function exit(message: string): never {
  console.error(message)
  process.exit(1)
}
