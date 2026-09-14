import { z } from 'zod';
export const orderSchema = z.strictObject({
  order_id: z.string().trim().min(1).max(200),
  customer: z.strictObject({email: z.email().max(254), name: z.string().trim().min(1).max(200)}),
  items: z.array(z.strictObject({sku: z.string().trim().min(1).max(100), qty: z.number().int().min(1).max(10000), unit_price: z.number().min(0).max(1000000).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001, 'Use at most two decimal places')})).min(1).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotency_key: z.string().trim().min(1).max(200),
});
export type OrderInput = z.infer<typeof orderSchema>;
export const statuses = ['RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED_ENRICHMENT'] as const;
