# Desafio Backend Pleno — Orquestrador de Pedidos

Criar uma API que:
1. Receba pedidos via **webhook**.
2. **Valide** e **enfileire** para processamento assíncrono.
3. **Enriqueça os dados** do pedido consultando um **serviço externo**.
4. Utilize **filas** para processamento e **mecanismos de retry** em caso de falhas.
5. Demonstre **boas práticas de código e arquitetura**.
6. Utilizar **NestJS**.

---

### Receber Pedido (Webhook)
`POST /webhooks/orders`

**Exemplo de payload:**
```json
{
  "order_id": "ext-123",
  "customer": { "email": "user@example.com", "name": "Ana" },
  "items": [{ "sku": "ABC123", "qty": 2, "unit_price": 59.9 }],
  "currency": "USD",
  "idempotency_key": "uuid-or-hash"
}
```

**Requisitos:**
- Validar o payload recebido.
- Garantir **idempotência** (não processar o mesmo pedido duas vezes).
- Enfileirar o pedido para processamento.
- Persistir o pedido no banco (status inicial: `RECEIVED`).

---

### Enriquecimento
- Consultar um **serviço externo** para complementar informações do pedido (por exemplo, converter o total para outra moeda ou validar dados de cliente).
- Atualizar o pedido com as informações obtidas.
- Em caso de erro:
    - Retentar algumas vezes com backoff.
    - Caso todas as tentativas falhem, enviar o job para uma **DLQ (Dead Letter Queue)**.
    - Atualizar o status para `FAILED_ENRICHMENT`.

---

### Consulta e Administração
- `GET /orders` — listar pedidos, com filtro opcional por status.
- `GET /orders/:id` — exibir os detalhes de um pedido.
- `GET /queue/metrics` — exibir informações gerais da fila.

---

### Sugestão de Integração Externa
Você pode escolher **qualquer serviço externo público** para demonstrar o uso de integrações.  
Algumas possibilidades incluem:
- API de câmbio (ex.: para converter valores de moedas);
- API de CEP (ex.: para validar endereços de clientes);
- API de produtos (ex.: para validar SKUs);
- API de tempo ou geolocalização (apenas para demonstrar integração).
---

### Testes (opcionais)
Os testes são opcionais, mas podem demonstrar melhor sua capacidade de estruturar o código e validar comportamentos.  
É importante que o fluxo da **fila** esteja representado nos testes, validando o processamento assíncrono e as transições de status.

---
### Entregáveis
Repositório público (GitHub ou GitLab) com o código do desafio implementado.
