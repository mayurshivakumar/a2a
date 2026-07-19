import { afterEach, describe, expect, it, vi } from 'vitest';
import { createA2AServer } from '../src/a2a/server.js';
import { extractUserText } from '../src/a2a/messages.js';
import { createMathCard } from '../src/agents/cards.js';
import {
  RemoteAgentError,
  callRemoteAgent,
  createRemoteClientFactory,
  createSpecialistTool,
} from '../src/agents/remote-tools.js';

const applications = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()));
});

async function startNetworkSpecialist() {
  const card = createMathCard('http://127.0.0.1');
  const executor = {
    async execute(requestContext, eventBus) {
      eventBus.publish({
        kind: 'message',
        role: 'agent',
        messageId: 'network-response',
        contextId: requestContext.contextId,
        taskId: requestContext.taskId,
        parts: [
          {
            kind: 'text',
            text: `remote: ${extractUserText(requestContext.userMessage)}`,
          },
        ],
      });
      eventBus.finished();
    },
    async cancelTask() {},
  };
  const application = createA2AServer({
    host: '127.0.0.1',
    port: 0,
    agentCard: card,
    executor,
  });
  const requests = [];
  application.server.ext('onRequest', (request, h) => {
    requests.push({ method: request.method, path: request.path });
    return h.continue;
  });
  applications.push(application);
  await application.start();

  card.url = `${application.server.info.uri}/a2a/jsonrpc`;
  card.additionalInterfaces[0].url = card.url;
  return { application, requests };
}

describe('remote specialist A2A tools', () => {
  it('discovers an Agent Card and sends a Message over real HTTP', async () => {
    const { application, requests } = await startNetworkSpecialist();
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const result = await callRemoteAgent({
      agentName: 'Math Specialist Agent',
      agentUrl: application.server.info.uri,
      request: 'What is 2 + 2?',
      timeoutMs: 2_000,
      clientFactory: createRemoteClientFactory({ timeoutMs: 2_000 }),
      idFactory: () => 'network-request',
      logger,
    });

    expect(result).toBe('remote: What is 2 + 2?');
    expect(requests).toContainEqual({
      method: 'get',
      path: '/.well-known/agent-card.json',
    });
    expect(requests).toContainEqual({ method: 'post', path: '/a2a/jsonrpc' });
    expect(logger.debug).toHaveBeenCalledWith(
      'calling remote specialist',
      expect.objectContaining({ agentName: 'Math Specialist Agent' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'remote specialist responded',
      expect.objectContaining({ agentName: 'Math Specialist Agent' }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses createFromUrl for every function-tool invocation', async () => {
    const createFromUrl = vi.fn(async () => ({
      sendMessage: vi.fn(async () => ({
        kind: 'message',
        role: 'agent',
        messageId: 'response',
        parts: [{ kind: 'text', text: 'specialist result' }],
      })),
    }));
    const clientFactoryFactory = vi.fn(() => ({ createFromUrl }));
    const specialistTool = createSpecialistTool({
      name: 'ask_math_specialist',
      description: 'Ask math.',
      agentName: 'Math Specialist Agent',
      agentUrl: 'http://math.example.test',
      timeoutMs: 1_000,
      clientFactoryFactory,
    });

    await specialistTool.invoke(undefined, JSON.stringify({ request: 'first' }));
    await specialistTool.invoke(undefined, JSON.stringify({ request: 'second' }));

    expect(clientFactoryFactory).toHaveBeenCalledTimes(2);
    expect(createFromUrl).toHaveBeenNthCalledWith(1, 'http://math.example.test');
    expect(createFromUrl).toHaveBeenNthCalledWith(2, 'http://math.example.test');
  });

  it('forwards sessionId into the outgoing message metadata when provided', async () => {
    const sendMessage = vi.fn(async () => ({
      kind: 'message',
      role: 'agent',
      messageId: 'response',
      parts: [{ kind: 'text', text: 'ok' }],
    }));
    const clientFactory = { createFromUrl: vi.fn(async () => ({ sendMessage })) };

    await callRemoteAgent({
      agentName: 'Math Specialist Agent',
      agentUrl: 'http://math.example.test',
      request: 'question',
      timeoutMs: 1_000,
      clientFactory,
      idFactory: () => 'msg-1',
      sessionId: 'session-xyz',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ metadata: { sessionId: 'session-xyz' } }),
      }),
      expect.anything(),
    );
  });

  it('omits message metadata when no sessionId is provided', async () => {
    const sendMessage = vi.fn(async () => ({
      kind: 'message',
      role: 'agent',
      messageId: 'response',
      parts: [{ kind: 'text', text: 'ok' }],
    }));
    const clientFactory = { createFromUrl: vi.fn(async () => ({ sendMessage })) };

    await callRemoteAgent({
      agentName: 'Math Specialist Agent',
      agentUrl: 'http://math.example.test',
      request: 'question',
      timeoutMs: 1_000,
      clientFactory,
      idFactory: () => 'msg-1',
    });

    const [{ message }] = sendMessage.mock.calls[0];
    expect(message).not.toHaveProperty('metadata');
  });

  it('forwards sessionId from the run context into the remote call', async () => {
    const sendMessage = vi.fn(async () => ({
      kind: 'message',
      role: 'agent',
      messageId: 'response',
      parts: [{ kind: 'text', text: 'specialist result' }],
    }));
    const clientFactoryFactory = vi.fn(() => ({
      createFromUrl: vi.fn(async () => ({ sendMessage })),
    }));
    const specialistTool = createSpecialistTool({
      name: 'ask_math_specialist',
      description: 'Ask math.',
      agentName: 'Math Specialist Agent',
      agentUrl: 'http://math.example.test',
      timeoutMs: 1_000,
      clientFactoryFactory,
    });

    await specialistTool.invoke(
      { context: { sessionId: 'session-xyz' } },
      JSON.stringify({ request: 'first' }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ metadata: { sessionId: 'session-xyz' } }),
      }),
      expect.anything(),
    );
  });

  it('converts timeouts and invalid results into safe remote errors', async () => {
    const timeout = new Error('private timeout detail');
    timeout.name = 'TimeoutError';
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await expect(
      callRemoteAgent({
        agentName: 'Math Specialist Agent',
        agentUrl: 'http://math.example.test',
        request: 'question',
        timeoutMs: 100,
        clientFactory: { createFromUrl: vi.fn().mockRejectedValue(timeout) },
        logger,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'RemoteAgentError',
        message: 'Math Specialist Agent is unavailable. The request timed out.',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'remote specialist failed',
      expect.objectContaining({ agentName: 'Math Specialist Agent', err: timeout }),
    );

    await expect(
      callRemoteAgent({
        agentName: 'Math Specialist Agent',
        agentUrl: 'http://math.example.test',
        request: 'question',
        timeoutMs: 100,
        clientFactory: {
          createFromUrl: vi.fn(async () => ({ sendMessage: vi.fn(async () => ({})) })),
        },
      }),
    ).rejects.toBeInstanceOf(RemoteAgentError);
  });
});
