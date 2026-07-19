import { describe, expect, it, vi } from 'vitest';
import { OpenAIAgentExecutor } from '../src/a2a/executor.js';

function createContext(parts = [{ kind: 'text', text: 'hello' }]) {
  return {
    contextId: 'context-1',
    taskId: 'task-1',
    userMessage: {
      kind: 'message',
      role: 'user',
      messageId: 'user-message-1',
      parts,
    },
  };
}

function createEventBus() {
  return {
    events: [],
    finishedCalls: 0,
    publish(event) {
      this.events.push(event);
    },
    finished() {
      this.finishedCalls += 1;
    },
  };
}

describe('OpenAIAgentExecutor', () => {
  it('runs the OpenAI agent and publishes a text Message', async () => {
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: 'agent answer' });
    const logger = { debug: vi.fn(), error: vi.fn() };
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger,
    });
    const eventBus = createEventBus();

    await executor.execute(createContext(), eventBus);

    expect(runAgent).toHaveBeenCalledWith(
      { name: 'Test Agent' },
      'hello',
      expect.objectContaining({
        workflowName: 'Test Agent A2A request',
        groupId: 'context-1',
      }),
    );
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]).toMatchObject({
      kind: 'message',
      role: 'agent',
      contextId: 'context-1',
      taskId: 'task-1',
      parts: [{ kind: 'text', text: 'agent answer' }],
    });
    expect(eventBus.finishedCalls).toBe(1);
    expect(logger.debug).toHaveBeenCalledWith(
      'executing agent request',
      expect.objectContaining({ agent: 'Test Agent', contextId: 'context-1', taskId: 'task-1' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'agent request completed',
      expect.objectContaining({ agent: 'Test Agent', contextId: 'context-1' }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('derives the session from incoming message metadata when present', async () => {
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: 'agent answer' });
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger: { debug: vi.fn(), error: vi.fn() },
    });
    const eventBus = createEventBus();
    const context = createContext();
    context.userMessage.metadata = { sessionId: 'propagated-session' };

    await executor.execute(context, eventBus);

    expect(runAgent).toHaveBeenCalledWith(
      { name: 'Test Agent' },
      'hello',
      expect.objectContaining({
        groupId: 'propagated-session',
        context: { sessionId: 'propagated-session' },
      }),
    );
  });

  it('falls back to contextId as the session when no metadata sessionId is present', async () => {
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: 'agent answer' });
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger: { debug: vi.fn(), error: vi.fn() },
    });
    const eventBus = createEventBus();

    await executor.execute(createContext(), eventBus);

    expect(runAgent).toHaveBeenCalledWith(
      { name: 'Test Agent' },
      'hello',
      expect.objectContaining({ groupId: 'context-1', context: { sessionId: 'context-1' } }),
    );
  });

  it('runs the agent inside the injected withSession wrapper', async () => {
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: 'agent answer' });
    const withSession = vi.fn((sessionId, fn) => fn());
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger: { debug: vi.fn(), error: vi.fn() },
      withSession,
    });
    const eventBus = createEventBus();

    await executor.execute(createContext(), eventBus);

    expect(withSession).toHaveBeenCalledWith('context-1', expect.any(Function));
    expect(runAgent).toHaveBeenCalled();
  });

  it('logs the langfuse session URL when getSessionUrl resolves one', async () => {
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: 'agent answer' });
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const getSessionUrl = vi.fn(
      (sessionId) => `https://us.cloud.langfuse.com/project/project-123/sessions/${sessionId}`,
    );
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger,
      getSessionUrl,
    });
    const eventBus = createEventBus();

    await executor.execute(createContext(), eventBus);

    expect(getSessionUrl).toHaveBeenCalledWith('context-1');
    expect(logger.info).toHaveBeenCalledWith('langfuse session', {
      sessionId: 'context-1',
      url: 'https://us.cloud.langfuse.com/project/project-123/sessions/context-1',
    });
  });

  it('does not log a langfuse session line when no session URL is available', async () => {
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: 'agent answer' });
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger,
    });
    const eventBus = createEventBus();

    await executor.execute(createContext(), eventBus);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('returns a safe text response for invalid input', async () => {
    const runAgent = vi.fn();
    const logger = { debug: vi.fn(), error: vi.fn() };
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent,
      logger,
    });
    const eventBus = createEventBus();

    await executor.execute(createContext([{ kind: 'data', data: {} }]), eventBus);

    expect(runAgent).not.toHaveBeenCalled();
    expect(eventBus.events[0].parts[0].text).toMatch(/non-empty text messages/);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'agent execution failed',
      expect.objectContaining({ agent: 'Test Agent', contextId: 'context-1' }),
    );
  });

  it('returns a safe text response when the model fails', async () => {
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent: vi.fn().mockRejectedValue(new Error('secret provider detail')),
      logger: { debug: vi.fn(), error: vi.fn() },
    });
    const eventBus = createEventBus();

    await executor.execute(createContext(), eventBus);

    expect(eventBus.events[0].parts[0].text).toBe(
      'The agent could not complete the request. Please try again.',
    );
  });

  it('exposes the required no-op cancellation method', async () => {
    const executor = new OpenAIAgentExecutor({
      agent: { name: 'Test Agent' },
      runAgent: vi.fn(),
    });

    await expect(executor.cancelTask('task-1', createEventBus())).resolves.toBeUndefined();
  });
});
