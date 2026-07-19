import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses the documented local defaults', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'test-key' });

    expect(config).toEqual({
      model: 'gpt-5.4-mini',
      host: 'localhost',
      ports: { router: 4000, math: 4001, writing: 4002 },
      urls: {
        router: 'http://localhost:4000',
        math: 'http://localhost:4001',
        writing: 'http://localhost:4002',
      },
      requestTimeoutMs: 30_000,
      logLevel: 'info',
      logPretty: false,
      langfuse: {
        enabled: false,
        publicKey: undefined,
        secretKey: undefined,
        baseUrl: 'https://us.cloud.langfuse.com',
      },
    });
  });

  it('validates and normalizes overrides', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      A2A_HOST: '127.0.0.1',
      ROUTER_PORT: '4100',
      MATH_PORT: '4101',
      WRITING_PORT: '4102',
      MATH_AGENT_URL: 'https://math.example.test/',
      WRITING_AGENT_URL: 'https://writing.example.test///',
      A2A_REQUEST_TIMEOUT_MS: '1500',
    });

    expect(config.model).toBe('gpt-test');
    expect(config.host).toBe('127.0.0.1');
    expect(config.ports).toEqual({ router: 4100, math: 4101, writing: 4102 });
    expect(config.urls.math).toBe('https://math.example.test');
    expect(config.urls.writing).toBe('https://writing.example.test');
    expect(config.requestTimeoutMs).toBe(1500);
  });

  it('fails early when the API key is missing', () => {
    expect(() => loadConfig({})).toThrow(/OPENAI_API_KEY is required/);
  });

  it('derives log format from LOG_FORMAT when set', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'pretty',
    });

    expect(config.logLevel).toBe('debug');
    expect(config.logPretty).toBe(true);
  });

  it('falls back to NODE_ENV when LOG_FORMAT is unset', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      NODE_ENV: 'development',
    });

    expect(config.logPretty).toBe(true);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: 'test-key', LOG_LEVEL: 'verbose-ish' }),
    ).toThrow(/LOG_LEVEL/);
  });

  it('enables langfuse tracing when both keys are present', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test',
    });

    expect(config.langfuse).toEqual({
      enabled: true,
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://us.cloud.langfuse.com',
    });
  });

  it('keeps langfuse disabled when only one key is present', () => {
    expect(
      loadConfig({ OPENAI_API_KEY: 'test-key', LANGFUSE_PUBLIC_KEY: 'pk-test' }).langfuse.enabled,
    ).toBe(false);
  });

  it('lets LANGFUSE_TRACING override the key-presence default in both directions', () => {
    expect(
      loadConfig({
        OPENAI_API_KEY: 'test-key',
        LANGFUSE_PUBLIC_KEY: 'pk-test',
        LANGFUSE_SECRET_KEY: 'sk-test',
        LANGFUSE_TRACING: 'false',
      }).langfuse.enabled,
    ).toBe(false);

    expect(
      loadConfig({ OPENAI_API_KEY: 'test-key', LANGFUSE_TRACING: 'true' }).langfuse.enabled,
    ).toBe(true);
  });

  it('treats a blank LANGFUSE_SECRET_KEY as absent, matching a `KEY=` line in .env', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_TRACING: 'false',
    });

    expect(config.langfuse.secretKey).toBeUndefined();
    expect(config.langfuse.enabled).toBe(false);
  });

  it('accepts a custom LANGFUSE_BASE_URL', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      LANGFUSE_BASE_URL: 'https://langfuse.internal.example.test',
    });

    expect(config.langfuse.baseUrl).toBe('https://langfuse.internal.example.test');
  });
});
