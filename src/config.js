import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);
const timeoutSchema = z.coerce.number().int().positive().max(300_000);
// `.env` commonly leaves unset optional secrets as a blank assignment (`KEY=`),
// which dotenv loads as `''`, not `undefined`. Treat blank the same as absent.
const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const environmentSchema = z.object({
  OPENAI_API_KEY: z
    .string({ error: 'OPENAI_API_KEY is required' })
    .trim()
    .min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-5.4-mini'),
  A2A_HOST: z.string().trim().min(1).default('localhost'),
  ROUTER_PORT: portSchema.default(4000),
  MATH_PORT: portSchema.default(4001),
  WRITING_PORT: portSchema.default(4002),
  MATH_AGENT_URL: z.url().optional(),
  WRITING_AGENT_URL: z.url().optional(),
  A2A_REQUEST_TIMEOUT_MS: timeoutSchema.default(30_000),
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
    .default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  NODE_ENV: z.string().trim().optional(),
  LANGFUSE_PUBLIC_KEY: optionalTrimmedString,
  LANGFUSE_SECRET_KEY: optionalTrimmedString,
  LANGFUSE_BASE_URL: z.url().default('https://us.cloud.langfuse.com'),
  LANGFUSE_TRACING: z.enum(['true', 'false']).optional(),
});

function withoutTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function formatIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
}

export function loadConfig(environment = process.env) {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${formatIssues(result.error)}`);
  }

  const values = result.data;
  const mathAgentUrl = withoutTrailingSlash(
    values.MATH_AGENT_URL ?? `http://localhost:${values.MATH_PORT}`,
  );
  const writingAgentUrl = withoutTrailingSlash(
    values.WRITING_AGENT_URL ?? `http://localhost:${values.WRITING_PORT}`,
  );
  const hasLangfuseKeys = Boolean(values.LANGFUSE_PUBLIC_KEY && values.LANGFUSE_SECRET_KEY);
  const langfuseEnabled =
    values.LANGFUSE_TRACING === undefined ? hasLangfuseKeys : values.LANGFUSE_TRACING === 'true';

  return {
    model: values.OPENAI_MODEL,
    host: values.A2A_HOST,
    ports: {
      router: values.ROUTER_PORT,
      math: values.MATH_PORT,
      writing: values.WRITING_PORT,
    },
    urls: {
      router: `http://localhost:${values.ROUTER_PORT}`,
      math: mathAgentUrl,
      writing: writingAgentUrl,
    },
    requestTimeoutMs: values.A2A_REQUEST_TIMEOUT_MS,
    logLevel: values.LOG_LEVEL,
    logPretty: values.LOG_FORMAT
      ? values.LOG_FORMAT === 'pretty'
      : values.NODE_ENV === 'development',
    langfuse: {
      enabled: langfuseEnabled,
      publicKey: values.LANGFUSE_PUBLIC_KEY,
      secretKey: values.LANGFUSE_SECRET_KEY,
      baseUrl: values.LANGFUSE_BASE_URL,
    },
  };
}
