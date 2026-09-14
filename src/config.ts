function integer(name: string, fallback: number, max = 2147483647): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: integer('PORT', 3000, 65535),
  database: process.env.DATABASE_PATH ?? './data/orders.sqlite',
  target: process.env.TARGET_CURRENCY ?? 'BRL',
  api: process.env.EXCHANGE_API_URL ?? 'https://api.frankfurter.dev/v1/latest',
  attempts: integer('MAX_ATTEMPTS', 3, 10),
  backoff: integer('RETRY_BASE_MS', 1000, 3600000),
  poll: integer('POLL_MS', 250, 60000),
  timeout: integer('HTTP_TIMEOUT_MS', 5000, 60000),
};
if (!/^[A-Z]{3}$/.test(config.target)) throw new Error('Invalid TARGET_CURRENCY');
if (!['http:', 'https:'].includes(new URL(config.api).protocol)) throw new Error('Invalid EXCHANGE_API_URL');
