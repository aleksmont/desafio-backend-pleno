import { z } from 'zod';
import Decimal from 'decimal.js';

export const orderStatuses = ['RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED_ENRICHMENT'] as const;
export const queueStates = ['WAITING', 'ACTIVE', 'RETRY', 'COMPLETED', 'DLQ'] as const;

export const orderSchema = z.strictObject({
  order_id: z.string().trim().min(1).max(200),
  customer: z.strictObject({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(200),
  }),
  items: z
    .array(
      z.strictObject({
        sku: z.string().trim().min(1).max(100),
        qty: z.number().int().min(1).max(10000),
        unit_price: z
          .number()
          .min(0)
          .max(1000000)
          .refine(
            (value) => new Decimal(value).decimalPlaces() <= 2,
            'Use at most two decimal places',
          ),
      }),
    )
    .min(1)
    .max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotency_key: z.string().trim().min(1).max(200),
});

const integerQuery = (fallback: number, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

export const listOrdersSchema = z.strictObject({
  status: z.enum(orderStatuses).optional(),
  limit: integerQuery(50, 1, 100),
  offset: integerQuery(0, 0, Number.MAX_SAFE_INTEGER),
});

export type OrderInput = z.infer<typeof orderSchema>;
export type ListOrders = z.infer<typeof listOrdersSchema>;
export type OrderStatus = (typeof orderStatuses)[number];
export type QueueState = (typeof queueStates)[number];
