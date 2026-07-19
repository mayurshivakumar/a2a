import { describe, expect, it, vi } from 'vitest';
import { LangfuseAgentsBridge, initTracing, resolveLangfuseProjectId } from '../src/tracing.js';

function fakeObservation() {
  const observation = {
    update: vi.fn(() => observation),
    end: vi.fn(),
    startObservation: vi.fn(() => fakeObservation()),
  };
  return observation;
}

function baseConfig(overrides = {}) {
  return {
    langfuse: {
      enabled: false,
      publicKey: undefined,
      secretKey: undefined,
      baseUrl: 'https://us.cloud.langfuse.com',
      ...overrides,
    },
  };
}

describe('initTracing', () => {
  it('returns a no-op tracing handle when disabled', async () => {
    const tracing = await initTracing(baseConfig());

    expect(tracing.enabled).toBe(false);
    const result = await tracing.withSession('session-1', () => 'ran');
    expect(result).toBe('ran');
    expect(tracing.getSessionUrl('session-1')).toBeUndefined();
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });
});

describe('resolveLangfuseProjectId', () => {
  function fakeClient(projects) {
    return {
      api: { projects: { get: vi.fn().mockResolvedValue({ data: projects }) } },
      shutdown: vi.fn(),
    };
  }

  it('resolves the project id from the first project associated with the key pair', async () => {
    const client = fakeClient([{ id: 'project-123' }]);

    const { projectId, client: returnedClient } = await resolveLangfuseProjectId({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://us.cloud.langfuse.com',
      createLangfuseClient: () => client,
    });

    expect(projectId).toBe('project-123');
    expect(returnedClient).toBe(client);
  });

  it('logs a warning and leaves projectId undefined when the API call fails', async () => {
    const logger = { warn: vi.fn() };
    const createLangfuseClient = () => ({
      api: { projects: { get: vi.fn().mockRejectedValue(new Error('unauthorized')) } },
    });

    const { projectId, client } = await resolveLangfuseProjectId({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://us.cloud.langfuse.com',
      logger,
      createLangfuseClient,
    });

    expect(projectId).toBeUndefined();
    expect(client).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'failed to resolve langfuse project id; session URLs will be omitted from logs',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });
});

describe('LangfuseAgentsBridge', () => {
  it('creates a root observation on trace start and ends it on trace end', async () => {
    const root = fakeObservation();
    const startObservationImpl = vi.fn(() => root);
    const bridge = new LangfuseAgentsBridge({ startObservationImpl });
    const trace = { traceId: 'trace-1', name: 'Router Agent A2A request', groupId: 'session-1' };

    await bridge.onTraceStart(trace);
    expect(startObservationImpl).toHaveBeenCalledWith(trace.name, {}, { asType: 'span' });

    await bridge.onTraceEnd(trace);
    expect(root.end).toHaveBeenCalledOnce();
  });

  it('nests a generation span under its parent with generation attributes', async () => {
    const root = fakeObservation();
    const bridge = new LangfuseAgentsBridge({ startObservationImpl: () => root });
    const trace = { traceId: 'trace-1', name: 'trace' };
    await bridge.onTraceStart(trace);

    const span = {
      traceId: 'trace-1',
      spanId: 'span-1',
      parentId: null,
      error: null,
      spanData: {
        type: 'generation',
        model: 'gpt-5.4-mini',
        input: [{ role: 'user', content: 'hi' }],
        output: [{ role: 'assistant', content: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    };

    await bridge.onSpanStart(span);
    expect(root.startObservation).toHaveBeenCalledWith(
      'gpt-5.4-mini',
      { model: 'gpt-5.4-mini', input: span.spanData.input },
      { asType: 'generation' },
    );

    const generationObservation = root.startObservation.mock.results[0].value;
    await bridge.onSpanEnd(span);
    expect(generationObservation.update).toHaveBeenCalledWith({
      output: span.spanData.output,
      usageDetails: { input: 10, output: 20 },
    });
    expect(generationObservation.end).toHaveBeenCalledOnce();
  });

  it('maps a function span to a tool observation with parsed JSON input/output', async () => {
    const root = fakeObservation();
    const bridge = new LangfuseAgentsBridge({ startObservationImpl: () => root });
    const trace = { traceId: 'trace-1', name: 'trace' };
    await bridge.onTraceStart(trace);

    const span = {
      traceId: 'trace-1',
      spanId: 'span-2',
      parentId: null,
      error: null,
      spanData: {
        type: 'function',
        name: 'ask_math_specialist',
        input: JSON.stringify({ request: 'What is 2 + 2?' }),
        output: JSON.stringify('4'),
      },
    };

    await bridge.onSpanStart(span);
    expect(root.startObservation).toHaveBeenCalledWith(
      'ask_math_specialist',
      { input: { request: 'What is 2 + 2?' } },
      { asType: 'tool' },
    );

    const toolObservation = root.startObservation.mock.results[0].value;
    await bridge.onSpanEnd(span);
    expect(toolObservation.update).toHaveBeenCalledWith({ output: '4' });
  });

  it('maps an agent span to an agent observation carrying tools/handoffs metadata', async () => {
    const root = fakeObservation();
    const bridge = new LangfuseAgentsBridge({ startObservationImpl: () => root });
    await bridge.onTraceStart({ traceId: 'trace-1', name: 'trace' });

    const span = {
      traceId: 'trace-1',
      spanId: 'span-3',
      parentId: null,
      error: null,
      spanData: { type: 'agent', name: 'Router Agent', tools: ['ask_math_specialist'], handoffs: [] },
    };

    await bridge.onSpanStart(span);
    expect(root.startObservation).toHaveBeenCalledWith(
      'Router Agent',
      { metadata: { tools: ['ask_math_specialist'], handoffs: [] } },
      { asType: 'agent' },
    );
  });

  it('nests a span under its parent span, not just the trace root', async () => {
    const root = fakeObservation();
    const bridge = new LangfuseAgentsBridge({ startObservationImpl: () => root });
    await bridge.onTraceStart({ traceId: 'trace-1', name: 'trace' });

    const agentSpan = {
      traceId: 'trace-1',
      spanId: 'agent-span',
      parentId: null,
      error: null,
      spanData: { type: 'agent', name: 'Router Agent' },
    };
    await bridge.onSpanStart(agentSpan);
    const agentObservation = root.startObservation.mock.results[0].value;

    const childSpan = {
      traceId: 'trace-1',
      spanId: 'child-span',
      parentId: 'agent-span',
      error: null,
      spanData: { type: 'function', name: 'ask_math_specialist', input: '{}', output: '{}' },
    };
    await bridge.onSpanStart(childSpan);

    expect(agentObservation.startObservation).toHaveBeenCalledWith(
      'ask_math_specialist',
      { input: {} },
      { asType: 'tool' },
    );
    expect(root.startObservation).toHaveBeenCalledTimes(1);
  });

  it('marks the observation as an error when the span failed', async () => {
    const root = fakeObservation();
    const bridge = new LangfuseAgentsBridge({ startObservationImpl: () => root });
    await bridge.onTraceStart({ traceId: 'trace-1', name: 'trace' });

    const span = {
      traceId: 'trace-1',
      spanId: 'span-err',
      parentId: null,
      error: { message: 'boom' },
      spanData: { type: 'function', name: 'ask_math_specialist', input: '{}', output: '' },
    };

    await bridge.onSpanStart(span);
    const observation = root.startObservation.mock.results[0].value;
    await bridge.onSpanEnd(span);

    expect(observation.update).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'ERROR', statusMessage: 'boom' }),
    );
  });

  it('ignores a span whose parent was never tracked, without throwing', async () => {
    const bridge = new LangfuseAgentsBridge({ startObservationImpl: () => fakeObservation() });

    await expect(
      bridge.onSpanStart({
        traceId: 'unknown-trace',
        spanId: 'orphan-span',
        parentId: null,
        spanData: { type: 'function', name: 'x', input: '{}', output: '{}' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      bridge.onSpanEnd({ traceId: 'unknown-trace', spanId: 'orphan-span', spanData: { type: 'function' } }),
    ).resolves.toBeUndefined();
  });

  it('logs a warning instead of throwing when the underlying SDK call fails', async () => {
    const logger = { warn: vi.fn() };
    const startObservationImpl = vi.fn(() => {
      throw new Error('sdk unavailable');
    });
    const bridge = new LangfuseAgentsBridge({ logger, startObservationImpl });

    await expect(
      bridge.onTraceStart({ traceId: 'trace-1', name: 'trace' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'langfuse trace bridge failed',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });
});
