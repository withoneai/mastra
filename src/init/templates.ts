/** The starter agent `init` writes to `src/mastra/agents/one-agent.ts`. */
export function agentFile(platforms: string[]): string {
  const entries = platforms.map((p) => `      ${/^[a-z_$][\w$]*$/i.test(p) ? p : `'${p}'`}: true,`).join('\n')
  return `import { Agent } from '@mastra/core/agent';
import { oneTools } from '@withone/mastra';

export const oneAgent = new Agent({
  id: 'one-agent',
  name: 'One agent',
  instructions: [
    'You help the user get things done in their connected apps through One.',
    'Use the tools to read and change real data; never invent results.',
    'If a tool returns connectRequired, give the user the link and ask them to try again after connecting.',
  ].join(' '),
  model: process.env.MODEL ?? 'anthropic/claude-sonnet-5-5',
  tools: oneTools({
    platforms: {
${entries}
    },
  }),
});
`
}
