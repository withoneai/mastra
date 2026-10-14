import { Agent } from '@mastra/core/agent'
import { oneTools } from '@withone/mastra'
import { authorizeUrl, oneConnect } from '../one-connect'

// Acts for whichever end user the request names (`requestContext.userId`), with only the
// access that user granted your Connect app.
export const personalAgent = oneConnect
  ? new Agent({
      id: 'personal',
      name: 'Personal assistant (One Connect)',
      instructions:
        'You help the current user in their own connected apps. Use the tools; never invent data. ' +
        'If a tool returns connectRequired, give the user the link and ask them to try again after connecting.',
      model: process.env.MODEL ?? 'anthropic/claude-sonnet-5-5',
      tools: oneTools({
        connect: oneConnect,
        userId: ({ requestContext }) => requestContext?.get('userId'),
        connectUrl: ({ platform, userId }) => (userId ? authorizeUrl(userId, platform) : undefined),
        platforms: Object.fromEntries(
          (process.env.PERSONAL_PLATFORMS ?? 'linear,gmail').split(',').map((p) => [p.trim(), 'discover' as const]),
        ),
      }),
    })
  : undefined
