import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IdempotencyConflict, OrdersRepository } from './orders.repository';
import { ListOrders, OrderInput } from './order.schema';
import { presentOrder } from './order';

@Injectable()
export class OrdersService {
  constructor(private readonly repository: OrdersRepository) {}

  receive(input: OrderInput) {
    try {
      const { order, duplicate } = this.repository.receive(input);
      return { ...presentOrder(order), duplicate };
    } catch (error) {
      if (error instanceof IdempotencyConflict) throw new ConflictException(error.message);
      throw error;
    }
  }

  get(id: string) {
    const order = this.repository.find(id);
    if (!order) throw new NotFoundException('Order not found');
    return presentOrder(order);
  }

  list(query: ListOrders) {
    return this.repository.list(query).map(presentOrder);
  }
  metrics() {
    return this.repository.metrics();
  }
}
