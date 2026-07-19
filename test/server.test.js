import { afterEach, describe, expect, it, vi } from 'vitest';
import { createA2AServer } from '../src/a2a/server.js';
import { createMathCard } from '../src/agents/cards.js';

const applications = [];

function createTestApplication({ logger } = {}) {
  const executor = {
    async execute(requestContext, eventBus) {
      eventBus.publish({
        kind: 'message',
        role: 'agent',
        messageId: 'response-message',
        contextId: requestContext.contextId,
        taskId: requestContext.taskId,
        parts: [{ kind: 'text', text: 'test response' }],
      });
      eventBus.finished();
    },
    async cancelTask() {},
  };
  const application = createA2AServer({
    host: 'localhost',
    port: 0,
    agentCard: createMathCard('http://localhost:4001'),
    executor,
    logger,
  });
  applications.push(application);
  return application;
}

function rpcPayload(method = 'message/send') {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'request-1',
    method,
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'user-message',
        parts: [{ kind: 'text', text: 'hello' }],
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()));
});

describe('Hapi A2A server', () => {
  it('publishes health and Agent Card endpoints', async () => {
    const application = createTestApplication();

    const health = await application.server.inject('/health');
    expect(health.statusCode).toBe(200);
    expect(health.result).toEqual({ status: 'ok', agent: 'Math Specialist Agent' });

    const card = await application.server.inject('/.well-known/agent-card.json');
    expect(card.statusCode).toBe(200);
    expect(card.result).toMatchObject({
      name: 'Math Specialist Agent',
      protocolVersion: '0.3.0',
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: false, pushNotifications: false },
    });
  });

  it('handles a valid A2A JSON-RPC message', async () => {
    const application = createTestApplication();
    const response = await application.server.inject({
      method: 'POST',
      url: '/a2a/jsonrpc',
      headers: { 'content-type': 'application/json' },
      payload: rpcPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.result).toMatchObject({
      jsonrpc: '2.0',
      id: 'request-1',
      result: {
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: 'test response' }],
      },
    });
  });

  it('returns JSON-RPC errors for malformed and invalid requests', async () => {
    const application = createTestApplication();
    const malformed = await application.server.inject({
      method: 'POST',
      url: '/a2a/jsonrpc',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.result.error.code).toBe(-32700);

    const invalid = await application.server.inject({
      method: 'POST',
      url: '/a2a/jsonrpc',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'message/send' }),
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.result.error.code).toBe(-32600);
  });

  it('rejects streaming through the SDK because the card disables it', async () => {
    const application = createTestApplication();
    const response = await application.server.inject({
      method: 'POST',
      url: '/a2a/jsonrpc',
      headers: { 'content-type': 'application/json' },
      payload: rpcPayload('message/stream'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.result.error.message).toMatch(/requires streaming capability/);
  });

  it('does not expose frontend or unrelated routes', async () => {
    const application = createTestApplication();
    expect((await application.server.inject('/')).statusCode).toBe(404);
  });

  it('logs one structured line per request via the injected logger', async () => {
    const logger = { info: vi.fn() };
    const application = createTestApplication({ logger });

    await application.server.inject('/health');

    expect(logger.info).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        method: 'get',
        path: '/health',
        status: 200,
        ms: expect.any(Number),
      }),
    );
  });

  it('logs the Boom status code for routes that do not exist', async () => {
    const logger = { info: vi.fn() };
    const application = createTestApplication({ logger });

    await application.server.inject('/');

    expect(logger.info).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({ method: 'get', path: '/', status: 404 }),
    );
  });
});
