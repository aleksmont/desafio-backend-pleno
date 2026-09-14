import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ValidationPipe } from '../common/validation.pipe';
import { ListOrders, listOrdersSchema, OrderInput, orderSchema } from './order.schema';
import { OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('webhooks/orders')
  @HttpCode(202)
  receive(@Body(new ValidationPipe(orderSchema)) input: OrderInput) {
    return this.orders.receive(input);
  }

  @Get('orders')
  list(@Query(new ValidationPipe(listOrdersSchema)) query: ListOrders) {
    return this.orders.list(query);
  }

  @Get('orders/:id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  @Get('queue/metrics')
  metrics() {
    return this.orders.metrics();
  }
}
