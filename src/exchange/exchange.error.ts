export class ExchangeError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
