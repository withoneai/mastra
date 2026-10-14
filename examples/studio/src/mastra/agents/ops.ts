import { Agent } from '@mastra/core/agent'
import { oneTools } from '@withone/mastra'

export const opsAgent = new Agent({
  id: 'ops',
  name: 'Ops copilot',
  instructions: 'You help the user across their connected apps. Use the tools; never invent data.',
  model: process.env.MODEL ?? 'anthropic/claude-sonnet-5-5',
  tools: oneTools({
    platforms: {
      'cal-com': { allowTools: ['cal_com_get_event_types', 'cal_com_get_my_profile'] },
      linear: 'discover',
    },
  }),
})
