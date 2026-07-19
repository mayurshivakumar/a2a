import Hapi from '@hapi/hapi';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import { noopLogger } from '../logger.js';

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === 'function';
}

export function createA2AServer({ host, port, agentCard, executor, logger = noopLogger }) {
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);
  const transportHandler = new JsonRpcTransportHandler(requestHandler);
  const server = Hapi.server({
    host,
    port,
    routes: {
      cors: false,
    },
  });

  server.ext('onPreResponse', (request, h) => {
    const status = request.response.isBoom
      ? request.response.output.statusCode
      : request.response.statusCode;
    logger.info('request completed', {
      method: request.method,
      path: request.path,
      status,
      ms: Date.now() - request.info.received,
    });
    return h.continue;
  });

  server.route([
    {
      method: 'GET',
      path: '/.well-known/agent-card.json',
      handler: async (_request, h) =>
        h.response(await requestHandler.getAgentCard()).type('application/json'),
    },
    {
      method: 'POST',
      path: '/a2a/jsonrpc',
      options: {
        payload: {
          allow: 'application/json',
          maxBytes: 1_048_576,
          output: 'data',
          parse: false,
        },
      },
      handler: async (request, h) => {
        const payload = Buffer.isBuffer(request.payload)
          ? request.payload.toString('utf8')
          : request.payload;
        const response = await transportHandler.handle(payload);

        if (isAsyncIterable(response)) {
          throw new Error('Streaming responses are not enabled for this example.');
        }

        return h.response(response).code(200).type('application/json');
      },
    },
    {
      method: 'GET',
      path: '/health',
      handler: (_request, h) =>
        h
          .response({
            status: 'ok',
            agent: agentCard.name,
          })
          .type('application/json'),
    },
  ]);

  return {
    server,
    taskStore,
    requestHandler,
    transportHandler,
    start: () => server.start(),
    stop: (options) => server.stop(options),
  };
}
