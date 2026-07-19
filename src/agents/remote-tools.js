import { randomUUID } from 'node:crypto';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { createUserMessage, extractA2AResultText } from '../a2a/messages.js';
import { noopLogger } from '../logger.js';

const specialistRequestSchema = z.object({
  request: z.string().trim().min(1),
});

export class RemoteAgentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RemoteAgentError';
  }
}

function createTimeoutFetch(timeoutMs, fetchImplementation = globalThis.fetch) {
  return (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    return fetchImplementation(input, { ...init, signal });
  };
}

export function createRemoteClientFactory({
  timeoutMs,
  fetchImplementation = globalThis.fetch,
}) {
  const timedFetch = createTimeoutFetch(timeoutMs, fetchImplementation);
  const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: timedFetch }),
    transports: [new JsonRpcTransportFactory({ fetchImpl: timedFetch })],
    preferredTransports: ['JSONRPC'],
  });

  return new ClientFactory(options);
}

function isTimeoutError(error) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export async function callRemoteAgent({
  agentName,
  agentUrl,
  request,
  timeoutMs,
  clientFactory = createRemoteClientFactory({ timeoutMs }),
  idFactory = randomUUID,
  logger = noopLogger,
  sessionId,
}) {
  logger.debug('calling remote specialist', { agentName, agentUrl });

  try {
    const client = await clientFactory.createFromUrl(agentUrl);
    const result = await client.sendMessage(
      {
        configuration: {
          blocking: true,
          acceptedOutputModes: ['text/plain'],
        },
        message: createUserMessage({
          text: request,
          idFactory,
          metadata: sessionId ? { sessionId } : undefined,
        }),
      },
      { signal: AbortSignal.timeout(timeoutMs) },
    );

    logger.debug('remote specialist responded', { agentName });
    return extractA2AResultText(result);
  } catch (error) {
    const detail = isTimeoutError(error) ? ' The request timed out.' : '';
    logger.warn('remote specialist failed', { agentName, agentUrl, err: error });
    throw new RemoteAgentError(`${agentName} is unavailable.${detail}`, { cause: error });
  }
}

export function createSpecialistTool({
  name,
  description,
  agentName,
  agentUrl,
  timeoutMs,
  clientFactoryFactory = () => createRemoteClientFactory({ timeoutMs }),
  logger = noopLogger,
}) {
  return tool({
    name,
    description,
    parameters: specialistRequestSchema,
    timeoutMs,
    timeoutBehavior: 'raise_exception',
    async execute({ request }, runContext) {
      return callRemoteAgent({
        agentName,
        agentUrl,
        request,
        timeoutMs,
        clientFactory: clientFactoryFactory(),
        logger,
        sessionId: runContext?.context?.sessionId,
      });
    },
    errorFunction(_context, error) {
      return error instanceof RemoteAgentError
        ? error.message
        : `${agentName} is unavailable.`;
    },
  });
}
