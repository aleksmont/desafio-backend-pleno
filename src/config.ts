import { z } from 'zod';

const positiveInteger = (fallback: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max))
    .default(fallback);

const environmentSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: positiveInteger(3000, 65535),
  DATABASE_PATH: z.string().trim().min(1).default('./data/orders.sqlite'),
  TARGET_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('BRL'),
  EXCHANGE_API_URL: z
    .url()
    .refine((value) => {
      const url = URL.parse(value);
      return (
        url !== null && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      );
    }, 'Use an HTTP(S) URL without credentials')
    .default('https://api.frankfurter.dev/v1/latest'),
  MAX_ATTEMPTS: positiveInteger(3, 10),
  RETRY_BASE_MS: positiveInteger(1000, 60000),
  POLL_MS: positiveInteger(250, 60000),
  HTTP_TIMEOUT_MS: positiveInteger(5000, 60000),
});

/** Read once at bootstrap, never as an import side effect. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  const env = result.data;
  return Object.freeze({
    host: env.HOST,
    port: env.PORT,
    database: env.DATABASE_PATH,
    target: env.TARGET_CURRENCY,
    api: env.EXCHANGE_API_URL,
    attempts: env.MAX_ATTEMPTS,
    backoff: env.RETRY_BASE_MS,
    poll: env.POLL_MS,
    timeout: env.HTTP_TIMEOUT_MS,
    leaseMs: env.HTTP_TIMEOUT_MS + 30000,
  });
}

export type AppConfig = ReturnType<typeof loadConfig>;
export const APP_CONFIG = Symbol('APP_CONFIG');
