import { describe, expect, it, vi } from 'vitest';
import { OpenAIAgentExecutor } from '../src/a2a/executor.js';
import { createRouterAgent } from '../src/agents/router.js';

function createEventBus() {
  return {
    events: [],
    publish(event) {
      this.events.push(event);
    },
    finished() {},
  };
}

function createRequestContext(text) {
  return {
    contextId: 'context-1',
    taskId: 'task-1',
    userMessage: {
      kind: 'message',
      role: 'user',
      messageId: 'message-1',
      parts: [{ kind: 'text', text }],
    },
  };
}

describe('Router Agent', () => {
  it('exposes only the required remote function tools and no handoffs', () => {
    const router = createRouterAgent({
      model: 'gpt-5.4-mini',
      mathAgentUrl: 'http://math.example.test',
      writingAgentUrl: 'http://writing.example.test',
      timeoutMs: 1_000,
    });

    expect(Object.values(router.tools).map((tool) => tool.name)).toEqual([
      'ask_math_specialist',
      'ask_writing_specialist',
    ]);
    expect(router.agent.handoffs).toEqual([]);
    expect(router.agent.modelSettings).toMatchObject({
      toolChoice: 'required',
      parallelToolCalls: true,
    });
  });

  it.each([
    ['math-only', 'Calculate 2 + 2.', ['math']],
    ['writing-only', 'Rewrite this sentence to be clearer.', ['writing']],
    [
      'mixed',
      'Calculate 2 + 2 and rewrite the result as a polished sentence.',
      ['math', 'writing'],
    ],
  ])('delegates the %s workflow through the selected A2A tools', async (_name, input, expected) => {
    const remoteCalls = [];
    const clientFactoryFactory = () => ({
      async createFromUrl(url) {
        return {
          async sendMessage(params) {
            const specialist = url.includes('math') ? 'math' : 'writing';
            remoteCalls.push({ specialist, params });
            return {
              kind: 'message',
              role: 'agent',
              messageId: `${specialist}-response`,
              parts: [{ kind: 'text', text: `${specialist} result` }],
            };
          },
        };
      },
    });
    const router = createRouterAgent({
      model: 'gpt-5.4-mini',
      mathAgentUrl: 'http://math.example.test',
      writingAgentUrl: 'http://writing.example.test',
      timeoutMs: 1_000,
      clientFactoryFactory,
    });
    const runAgent = vi.fn(async (agent, request) => {
      const results = [];
      const shouldUseMath = /calculate/i.test(request);
      const shouldUseWriting = /rewrite/i.test(request);

      if (shouldUseMath) {
        results.push(
          await agent.tools[0].invoke(undefined, JSON.stringify({ request })),
        );
      }
      if (shouldUseWriting) {
        results.push(
          await agent.tools[1].invoke(undefined, JSON.stringify({ request })),
        );
      }

      return { finalOutput: results.join(' | ') };
    });
    const executor = new OpenAIAgentExecutor({
      agent: router.agent,
      runAgent,
      logger: { debug: vi.fn(), error: vi.fn() },
    });
    const eventBus = createEventBus();

    await executor.execute(createRequestContext(input), eventBus);

    expect(remoteCalls.map((call) => call.specialist)).toEqual(expected);
    expect(eventBus.events[0].parts[0].text).toBe(
      expected.map((specialist) => `${specialist} result`).join(' | '),
    );
  });
});
