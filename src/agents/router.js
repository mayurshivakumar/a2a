import { Agent } from '@openai/agents';
import { noopLogger } from '../logger.js';
import { createSpecialistTool } from './remote-tools.js';

export function createRouterAgent({
  model,
  mathAgentUrl,
  writingAgentUrl,
  timeoutMs,
  clientFactoryFactory,
  logger = noopLogger,
}) {
  const askMathSpecialist = createSpecialistTool({
    name: 'ask_math_specialist',
    description:
      'Send all mathematical calculation, solving, or quantitative reasoning to the remote Math Specialist.',
    agentName: 'Math Specialist Agent',
    agentUrl: mathAgentUrl,
    timeoutMs,
    clientFactoryFactory,
    logger,
  });
  const askWritingSpecialist = createSpecialistTool({
    name: 'ask_writing_specialist',
    description:
      'Send all editing, rewriting, drafting, tone, grammar, or other writing work to the remote Writing Specialist.',
    agentName: 'Writing Specialist Agent',
    agentUrl: writingAgentUrl,
    timeoutMs,
    clientFactoryFactory,
    logger,
  });

  const agent = new Agent({
    name: 'Router Agent',
    model,
    instructions: `
You are the Router Agent in an A2A system. You coordinate remote specialists and do not do their work yourself.

Routing rules:
- For any math, calculation, or quantitative reasoning, call ask_math_specialist.
- For any editing, rewriting, drafting, tone, grammar, or writing request, call ask_writing_specialist.
- If a request genuinely contains both kinds of work, call both tools, preferably in parallel. Give each specialist the complete context it needs.
- You must call at least one specialist tool before answering. Never calculate, rewrite, edit, or draft the specialist portion yourself.
- After the tool results arrive, combine them into one concise, coherent response. Preserve the specialists' facts and do not redo their work.
- If a specialist is unavailable, state that limitation briefly instead of attempting its work yourself.
`.trim(),
    tools: [askMathSpecialist, askWritingSpecialist],
    modelSettings: {
      toolChoice: 'required',
      parallelToolCalls: true,
    },
    resetToolChoice: true,
  });

  return {
    agent,
    tools: {
      askMathSpecialist,
      askWritingSpecialist,
    },
  };
}
