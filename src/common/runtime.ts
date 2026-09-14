export interface Clock {
  now(): number;
}
export const CLOCK = Symbol('CLOCK');
export const systemClock: Clock = { now: () => Date.now() };
export const RANDOM = Symbol('RANDOM');
export type Random = () => number;
export const HTTP_FETCH = Symbol('HTTP_FETCH');
export type HttpFetch = typeof fetch;
