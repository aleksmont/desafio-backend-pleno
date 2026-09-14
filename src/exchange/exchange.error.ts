export class ExchangeError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
