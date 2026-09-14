import 'reflect-metadata';
import { BadRequestException, Body, Controller, Get, HttpCode, Module, Param, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config } from './config';
import { orderSchema } from './order.schema';
import { OrdersService } from './orders.service';
import { QueueWorker } from './queue.worker';
@Controller()
class ApiController {
  constructor(private readonly orders:OrdersService) {}
  @Get() index() { return {name:'Orquestrador de Pedidos', endpoints:['GET /health','POST /webhooks/orders','GET /orders','GET /orders/:id','GET /queue/metrics']}; }
  @Get('health') health() { this.orders.metrics(); return {status:'ok'}; }
  @Post('webhooks/orders') @HttpCode(202) receive(@Body() body:unknown) {
    const result = orderSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.issues);
    return this.orders.receive(result.data);
  }
  @Get('orders') list(@Query('status') status?:string, @Query('limit') limit?:string, @Query('offset') offset?:string) { return this.orders.list(status, limit, offset); }
  @Get('orders/:id') get(@Param('id') id:string) { return this.orders.get(id); }
  @Get('queue/metrics') metrics() { return this.orders.metrics(); }
}
@Module({controllers:[ApiController], providers:[QueueWorker, OrdersService]})
class AppModule {}
export async function createApp() { const app = await NestFactory.create(AppModule); app.enableShutdownHooks(); return app; }
if (require.main === module) createApp().then(app => app.listen(config.port, config.host)).catch(error => { console.error(error); process.exitCode = 1; });
