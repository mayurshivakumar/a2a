import { noopLogger } from './logger.js';

const startOrder = ['math', 'writing', 'router'];

export async function startAgentCluster(cluster, { logger = noopLogger } = {}) {
  const started = [];

  try {
    for (const name of startOrder) {
      await cluster[name].start();
      started.push(name);
      logger.debug('server started', { role: name });
    }
  } catch (error) {
    for (const name of [...started].reverse()) {
      await cluster[name].stop({ timeout: 5_000 }).catch(() => {});
      logger.debug('server stopped during rollback', { role: name });
    }
    throw error;
  }

  return async function stopAgentCluster() {
    for (const name of [...started].reverse()) {
      await cluster[name].stop({ timeout: 5_000 });
      logger.debug('server stopped', { role: name });
    }
  };
}

export function installShutdownHandlers({
  stop,
  logger = noopLogger,
  processObject = process,
  onShutdown,
}) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; stopping A2A servers.`);

    try {
      await stop();
      await onShutdown?.();
    } catch (error) {
      logger.error('Failed to stop all A2A servers cleanly.', { err: error });
      processObject.exitCode = 1;
    }
  };

  processObject.once('SIGINT', () => shutdown('SIGINT'));
  processObject.once('SIGTERM', () => shutdown('SIGTERM'));

  return shutdown;
}
