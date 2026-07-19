import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { propagateAttributes, startObservation } from '@langfuse/tracing';
import { LangfuseClient } from '@langfuse/client';
import { addTraceProcessor } from '@openai/agents';
import { noopLogger } from './logger.js';

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function describeSpanStart(spanData) {
  switch (spanData.type) {
    case 'generation':
      return {
        asType: 'generation',
        name: spanData.model ?? 'generation',
        attributes: { model: spanData.model, input: spanData.input },
      };
    case 'function':
      return {
        asType: 'tool',
        name: spanData.name,
        attributes: { input: parseJsonMaybe(spanData.input) },
      };
    case 'agent':
      return {
        asType: 'agent',
        name: spanData.name,
        attributes: { metadata: { tools: spanData.tools, handoffs: spanData.handoffs } },
      };
    default:
      return { asType: 'span', name: spanData.name ?? spanData.type, attributes: {} };
  }
}

function describeSpanEnd(spanData, error) {
  const base = error ? { level: 'ERROR', statusMessage: error.message } : {};

  switch (spanData.type) {
    case 'generation':
      return {
        ...base,
        output: spanData.output,
        usageDetails: spanData.usage
          ? { input: spanData.usage.input_tokens, output: spanData.usage.output_tokens }
          : undefined,
      };
    case 'function':
      return { ...base, output: parseJsonMaybe(spanData.output) };
    default:
      return base;
  }
}

/**
 * Bridges the @openai/agents SDK's own trace/span lifecycle into Langfuse
 * observations, preserving parent/child structure via traceId/spanId/parentId.
 * Implements the TracingProcessor interface from @openai/agents-core.
 */
export class LangfuseAgentsBridge {
  constructor({ logger = noopLogger, startObservationImpl = startObservation } = {}) {
    this.logger = logger;
    this.startObservationImpl = startObservationImpl;
    this.observations = new Map();
  }

  async onTraceStart(trace) {
    try {
      const root = this.startObservationImpl(trace.name, {}, { asType: 'span' });
      this.observations.set(trace.traceId, root);
    } catch (err) {
      this.logger.warn('langfuse trace bridge failed', { err });
    }
  }

  async onTraceEnd(trace) {
    try {
      this.observations.get(trace.traceId)?.end();
    } catch (err) {
      this.logger.warn('langfuse trace bridge failed', { err });
    } finally {
      this.observations.delete(trace.traceId);
    }
  }

  async onSpanStart(span) {
    try {
      const parent = this.observations.get(span.parentId) ?? this.observations.get(span.traceId);
      if (!parent) return;

      const { asType, name, attributes } = describeSpanStart(span.spanData);
      this.observations.set(span.spanId, parent.startObservation(name, attributes, { asType }));
    } catch (err) {
      this.logger.warn('langfuse span bridge failed', { err });
    }
  }

  async onSpanEnd(span) {
    try {
      const observation = this.observations.get(span.spanId);
      if (!observation) return;

      observation.update(describeSpanEnd(span.spanData, span.error));
      observation.end();
    } catch (err) {
      this.logger.warn('langfuse span bridge failed', { err });
    } finally {
      this.observations.delete(span.spanId);
    }
  }

  // The OTel span processor owns batching/export; this bridge only maps
  // Agents SDK callbacks to Langfuse observations.
  async shutdown() {}
  async forceFlush() {}
}

/**
 * Resolves the Langfuse project id for the configured key pair, so session/trace
 * URLs can be built locally without a network round trip per request. Exported
 * standalone (rather than inlined in initTracing) so it can be unit tested without
 * touching the OTel/Agents SDK global registration side effects initTracing has.
 * Never throws: failures (bad keys, no network) are logged and leave projectId
 * undefined, so callers degrade to omitting session URLs.
 */
export async function resolveLangfuseProjectId({
  publicKey,
  secretKey,
  baseUrl,
  logger = noopLogger,
  createLangfuseClient = (params) => new LangfuseClient(params),
}) {
  try {
    const client = createLangfuseClient({ publicKey, secretKey, baseUrl });
    const projects = await client.api.projects.get();
    return { projectId: projects.data[0]?.id, client };
  } catch (err) {
    logger.warn('failed to resolve langfuse project id; session URLs will be omitted from logs', {
      err,
    });
    return { projectId: undefined, client: undefined };
  }
}

/**
 * Boots Langfuse tracing for the process (idempotent per call site: invoke
 * once from src/index.js). Disabled by default; enabling requires
 * config.langfuse.enabled (see src/config.js). When disabled, returns
 * no-op withSession/getSessionUrl/shutdown so callers don't need to branch.
 */
export async function initTracing(config, logger = noopLogger, { createLangfuseClient } = {}) {
  if (!config.langfuse.enabled) {
    return {
      enabled: false,
      withSession: (_sessionId, fn) => fn(),
      getSessionUrl: () => undefined,
      shutdown: async () => {},
    };
  }

  const { publicKey, secretKey, baseUrl } = config.langfuse;
  const spanProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  addTraceProcessor(new LangfuseAgentsBridge({ logger }));

  const { projectId, client } = await resolveLangfuseProjectId({
    publicKey,
    secretKey,
    baseUrl,
    logger,
    createLangfuseClient,
  });

  return {
    enabled: true,
    withSession: (sessionId, fn) => propagateAttributes({ sessionId }, fn),
    getSessionUrl: (sessionId) =>
      projectId ? `${baseUrl}/project/${projectId}/sessions/${sessionId}` : undefined,
    shutdown: async () => {
      await spanProcessor.forceFlush();
      await sdk.shutdown();
      await client?.shutdown();
    },
  };
}
