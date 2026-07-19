import 'dotenv/config';
import { createAgentCluster } from './cluster.js';
import { loadConfig } from './config.js';
import { installShutdownHandlers, startAgentCluster } from './launcher.js';
import { createLogger } from './logger.js';
import { initTracing } from './tracing.js';

let log;

async function main() {
  const config = loadConfig();
  log = createLogger({ level: config.logLevel, pretty: config.logPretty });

  const tracing = await initTracing(config, log);
  log.info('tracing configured', { enabled: tracing.enabled });

  const cluster = createAgentCluster(config, {
    logger: log,
    withSession: tracing.withSession,
    getSessionUrl: tracing.getSessionUrl,
  });
  const stop = await startAgentCluster(cluster, { logger: log });

  log.info('agent listening', { role: 'math', uri: cluster.math.server.info.uri });
  log.info('agent listening', { role: 'writing', uri: cluster.writing.server.info.uri });
  log.info('agent listening', { role: 'router', uri: cluster.router.server.info.uri });

  installShutdownHandlers({ stop, logger: log, onShutdown: tracing.shutdown });
}

main().catch((error) => {
  // loadConfig() may throw before the configured logger exists. Failures after
  // configuration should retain the selected level and output format.
  (log ?? createLogger()).error('Unable to start the A2A example.', { err: error });
  process.exitCode = 1;
});
