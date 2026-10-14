# Changelog

## 0.1.0

First release.

- `oneTools()`: the apps connected on One as Mastra agent tools, worked out per request. With no options it serves every connected app. Per app: typed tools, `discover` (One's action selector plus search/run tools) or `all` (every action, for use with `ToolSearchProcessor`). Allow/deny globs, `requireApproval` (`true`, `'writes'` or globs), connect links for apps that aren't connected, and capped results.
- One Connect: per-user tools with `{ connectKey, loadUser }`, acting only within each user's grant.
- `OneToolProvider` (`@withone/mastra/provider`): One in Mastra Studio's agent editor.
- `oneStep()` (`@withone/mastra/workflows`): a One action as a workflow step, with optional approval.
- `oneTrigger()` (`@withone/mastra/triggers`): starts a workflow from One webhook-relay events.
- `npx @withone/mastra init`: wires all of this into a new or existing Mastra project.
- `examples/agent.ts`: ask an agent with your connected apps a question from the terminal.
