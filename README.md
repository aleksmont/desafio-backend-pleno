# Orquestrador de Pedidos — NestJS

API do [desafio original](CHALLENGE.md). Requer Node.js 24+ e npm.

## Executar

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Acesse http://127.0.0.1:3000 ou `GET /health`. `npm test` compila e testa o fluxo HTTP com um serviço externo controlado e banco temporário. `npm run dev` compila e inicia (sem hot reload).

## Exemplo

```sh
curl -X POST http://127.0.0.1:3000/webhooks/orders \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"ext-123","customer":{"email":"user@example.com","name":"Ana"},"items":[{"sku":"ABC123","qty":2,"unit_price":59.9}],"currency":"USD","idempotency_key":"demo-123"}'
curl http://127.0.0.1:3000/orders
curl 'http://127.0.0.1:3000/orders?status=COMPLETED&limit=50&offset=0'
curl http://127.0.0.1:3000/queue/metrics
```

`POST /webhooks/orders` retorna 202 com ID interno e status inicial RECEIVED. Repetições com o mesmo conteúdo retornam o mesmo ID e `duplicate: true`; mudanças de conteúdo com ID externo ou chave já usados retornam 409. Campos extras e payload inválido retornam 400. Preços aceitam duas casas decimais; moeda deve ser um código de três letras maiúsculas. `GET /orders/:id` consulta o ID interno e retorna 404 se inexistente.

## Processamento e persistência

SQLite salva pedidos e jobs em `data/orders.sqlite`. A inserção do pedido e seu estado WAITING é atômica. Um worker assíncrono consulta jobs disponíveis, reclama um job atomicamente, marca PROCESSING e consulta [Frankfurter](https://frankfurter.dev/) para converter o total para BRL. A mesma moeda usa taxa 1 sem consulta remota. Valores de origem são somados em centavos; a conversão é arredondada para duas casas.

Sucesso marca COMPLETED. Erros fazem até três tentativas totais com backoff exponencial (1s, 2s). Após esgotar, o pedido fica FAILED_ENRICHMENT e o job DLQ, persistindo o último erro. Liste a DLQ pelo filtro `status=FAILED_ENRICHMENT`. Métricas contam WAITING, ACTIVE, RETRY, COMPLETED e DLQ.

Leases recuperam jobs interrompidos após timeout HTTP + 30s. Reiniciar preserva a fila e a idempotência. O processamento tem semântica at-least-once: após queda, a consulta externa pode se repetir; não cria outro pedido. A DLQ fica no mesmo banco, sem reenvio automático ou endpoint de reprocessamento.

## Configuração

Veja `.env.example`: HOST (127.0.0.1), PORT (3000), DATABASE_PATH, TARGET_CURRENCY (BRL), EXCHANGE_API_URL, MAX_ATTEMPTS (3), RETRY_BASE_MS (1000), POLL_MS (250), HTTP_TIMEOUT_MS (5000). O banco e suas tabelas são criados automaticamente. A integração real requer internet; moedas não suportadas seguem retry/DLQ. Não precisa de chave de API, Docker ou Redis.

Esta implementação usa uma fila persistente SQLite para execução local e volume moderado, com um job por vez por processo. Não oferece autenticação; escuta apenas no loopback por padrão. O módulo `node:sqlite` pode emitir aviso experimental no Node 24; isso não impede a execução. Para alto volume, considere um broker dedicado e banco servidor. Não remova `data/` se quiser preservar os pedidos.
