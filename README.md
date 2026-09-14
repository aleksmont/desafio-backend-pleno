# Orquestrador de Pedidos

Implementação NestJS do [desafio original](CHALLENGE.md): webhook validado, idempotência, persistência, processamento assíncrono, enriquecimento de pedidos e fila de falhas. Node.js 24 e npm são os únicos pré-requisitos locais.

## Executar

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

API em http://127.0.0.1:3000; saúde em `GET /health`. Banco e tabelas são criados automaticamente. A integração real requer internet, mas não exige chave de API. O `.env` é opcional; seus valores de exemplo já são os padrões. `npm run dev` compila e inicia, sem hot reload.

```sh
curl -X POST http://127.0.0.1:3000/webhooks/orders \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"ext-123","customer":{"email":"ana@example.com","name":"Ana"},"items":[{"sku":"ABC123","qty":2,"unit_price":59.9}],"currency":"USD","idempotency_key":"demo-123"}'

curl http://127.0.0.1:3000/orders
curl 'http://127.0.0.1:3000/orders?status=COMPLETED&limit=50&offset=0'
curl http://127.0.0.1:3000/queue/metrics
```

## Contrato HTTP

| Método e rota           | Comportamento                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `POST /webhooks/orders` | 202 com ID interno, estado atual e `duplicate`                                        |
| `GET /orders`           | Array com paginação `limit` (1–100, padrão 50), `offset` (padrão 0) e filtro `status` |
| `GET /orders/:id`       | Detalhes pelo ID interno UUID; 404 quando inexistente                                 |
| `GET /queue/metrics`    | Contadores WAITING, ACTIVE, RETRY, COMPLETED, DLQ e total                             |
| `GET /health`           | Verifica a conexão com o banco; 200 com `status: ok`                                  |

Pedidos novos retornam `RECEIVED`. Campos extras, consultas ambíguas (como `limit=1&limit=2`), email inválido, itens vazios e valores fora dos limites retornam 400. Corpos acima de 100 KiB retornam 413. Preços não negativos aceitam até duas casas decimais; quantidades são inteiros positivos. A moeda usa três letras maiúsculas; suporte à moeda é confirmado durante o enriquecimento.

O mesmo ID externo/chave com conteúdo equivalente retorna o pedido existente, com `duplicate: true`, sem novo job. A ordem das propriedades JSON não muda essa identidade. Alterar conteúdo, reaproveitar só o ID ou só a chave retorna 409. A ordem dos itens faz parte do conteúdo. A idempotência dura enquanto o registro existir no banco.

O formato de validação é `{ code: "VALIDATION_ERROR", message, errors: [{ field, message }] }`, sem repetir os valores recebidos. `last_error` contém códigos estáveis de falha, nunca o corpo da resposta externa.

## Organização

- `src/orders`: contrato de entrada, cálculo de valores, apresentação, regras de idempotência, consultas e repositório SQL.
- `src/database`: conexão SQLite, transações e migração versionada.
- `src/exchange`: cliente HTTP, validação da resposta e classificação de falhas.
- `src/queue`: execução assíncrona e política de retry.
- `src/common`: relógio, transporte HTTP e validação injetáveis.
- `src/app.module.ts`: composição das dependências; `src/main.ts`: inicialização e encerramento.

A configuração é validada na inicialização, sem leitura de ambiente durante imports. Relógio, aleatoriedade e cliente HTTP são substituíveis nos testes. O serviço de pedidos não executa SQL, e o repositório não depende de exceções HTTP.

## Garantias da fila

A escolha de SQLite é deliberada: o [enunciado original da Buzzmates](https://github.com/buzzmates/desafio-backend-pleno) exige fila, backoff e DLQ, mas não determina um broker. Aqui, WAITING/RETRY representam os jobs disponíveis, ACTIVE representa a posse temporária pelo worker e DLQ é a fila lógica persistente de jobs que esgotaram as tentativas. Não se trata apenas de um status informativo: o worker consulta, adquire e processa esses registros de forma assíncrona, e deixa de consumir os jobs na DLQ. Os testes verificam esse ciclo, a concorrência e a recuperação após interrupção. Essa escolha reduz os serviços necessários para avaliar o desafio; seus limites operacionais estão descritos ao final.

SQLite em modo WAL persiste o pedido e seu job na mesma linha, dentro de uma transação. Isso evita uma janela entre gravar o pedido e publicar a mensagem. Cada processo executa um job por vez; processos independentes no mesmo banco disputam jobs com transações `BEGIN IMMEDIATE` e atualização atômica.

```text
RECEIVED / WAITING → PROCESSING / ACTIVE → COMPLETED
                          ↓
              RECEIVED / RETRY → nova tentativa
                          ↓
              FAILED_ENRICHMENT / DLQ
```

Cada aquisição recebe um token único e um lease de `HTTP_TIMEOUT_MS + 30s`. Um worker com token antigo ou lease expirado não pode concluir nem falhar o job. Após interrupção, o próximo polling recupera leases expirados e aguarda `RETRY_BASE_MS` antes da nova tentativa. Uma queda na última tentativa leva à DLQ. A moeda de destino e o orçamento de tentativas são persistidos por pedido, portanto mudar a configuração não altera pedidos já aceitos.

A semântica é **at-least-once**: uma queda após a consulta externa pode causar outra consulta, mas não outro registro de pedido. O encerramento interrompe o polling e espera o trabalho em andamento antes de fechar o banco. Uma falha de persistência mantém o lease para recuperação e não é classificada como falha do provedor.

## Integração e valores

O cliente usa a [API Frankfurter v1](https://frankfurter.dev/) para obter a taxa de câmbio. Valida moeda-base, data e taxa positiva. O timeout cobre cabeçalhos e corpo; respostas são limitadas a 64 KiB e redirects não são seguidos. Todos os pedidos consultam o serviço externo, inclusive quando a moeda de origem é igual à de destino. Nesse caso, uma cotação de referência confirma a moeda e a data no provedor; o total permanece inalterado com taxa 1. Se essa consulta falhar, o pedido segue o mesmo fluxo de retry.

Toda falha de enriquecimento, incluindo erros HTTP 4xx, timeouts, respostas inválidas, respostas excessivas e valores fora da faixa suportada, passa pelo orçamento configurado de tentativas. Apenas após esgotá-lo o job vai para a DLQ com status `FAILED_ENRICHMENT`. Essa política segue literalmente o enunciado, mesmo quando repetir um erro provavelmente não terá sucesso. O backoff é exponencial, com jitter de ±20%, respeita `Retry-After` e tem teto de 60 segundos. O padrão é de três tentativas totais. Liste a DLQ com `GET /orders?status=FAILED_ENRICHMENT`; não há reenvio automático nem endpoint de reprocessamento.

Valores de origem são somados em centavos. A multiplicação pela taxa usa `decimal.js`, com arredondamento half-up para duas casas decimais e verificação de inteiro seguro. O contrato deste desafio adota duas casas para todas as moedas; não implementa regras de casas decimais específicas por moeda ou contabilidade financeira.

## Configuração e atualização

| Variável           | Padrão                                  | Restrição                       |
| ------------------ | --------------------------------------- | ------------------------------- |
| `HOST`             | `127.0.0.1`                             | Não vazio                       |
| `PORT`             | `3000`                                  | 1–65535                         |
| `DATABASE_PATH`    | `./data/orders.sqlite`                  | Caminho persistente             |
| `TARGET_CURRENCY`  | `BRL`                                   | Três letras maiúsculas          |
| `EXCHANGE_API_URL` | `https://api.frankfurter.dev/v1/latest` | HTTP(S), sem credenciais na URL |
| `MAX_ATTEMPTS`     | `3`                                     | 1–10                            |
| `RETRY_BASE_MS`    | `1000`                                  | 1–60000                         |
| `POLL_MS`          | `250`                                   | 1–60000                         |
| `HTTP_TIMEOUT_MS`  | `5000`                                  | 1–60000                         |

A migração `user_version=1` preserva os registros da primeira versão e adiciona token de lease, orçamento de tentativas, moeda de destino e índices. Pedidos antigos recebem a configuração vigente durante a migração. Versões de banco mais novas que a aplicação são recusadas.

Para atualizar uma instalação existente: encerre todas as instâncias antigas, faça um backup consistente do SQLite, instale as dependências, compile e inicie a nova versão. Não execute versões antigas e novas simultaneamente durante a migração. Não apague `data/` se quiser preservar os pedidos. O Node 24 pode emitir um aviso experimental para `node:sqlite`.

## Testes e qualidade

```sh
npm test                 # compilação e suíte completa
npm run test:coverage    # cobertura em coverage/index.html e coverage/lcov.info
npm run lint             # ESLint com análise de tipos
npm run format:check     # Prettier
npm run check            # todos os checks anteriores relevantes
npm audit                # auditoria das dependências instaladas
```

A suíte inclui testes de domínio, repositório SQLite real, worker, cliente externo, HTTP e inicialização como processo. Cobre migração e reinício, quatro workers concorrentes no mesmo banco, webhooks simultâneos, leases expirados, falhas de persistência, retries/DLQ, timeout de corpo HTTP, limites de entrada, precisão monetária e SIGTERM. Os testes usam bancos temporários, transporte injetado ou servidores locais; não dependem da Frankfurter nem alteram o banco de desenvolvimento.

O CI executa formatação, análise estática e testes, exigindo no mínimo 90% de linhas/funções e 85% de ramificações. Inclui todos os arquivos da aplicação, inclusive a inicialização, e publica o relatório como artefato. As ações são fixadas por SHA. A cobertura mede execução, não prova ausência de bugs.

A árvore NestJS 11 fixa uma versão antiga de Multer. O override para Multer 2.4 mantém a mesma versão principal e corrige os avisos encontrados na auditoria, sem migrar todo o framework. Reavalie o override ao atualizar o NestJS.

## Limites operacionais

Esta solução atende execução local e volume moderado. SQLite tem um escritor por vez e chamadas síncronas; use disco local e não compartilhe o arquivo por filesystem de rede. Para grande volume ou múltiplos hosts, a evolução natural é um banco servidor e um broker dedicado, mantendo as mesmas garantias de idempotência e recuperação.

A API escuta no loopback por padrão e não implementa autenticação, assinatura de webhook, rate limiting, retenção de pedidos ou alta disponibilidade. Antes de expor dados reais em rede pública, essas decisões precisam ser implementadas conforme o ambiente. Não há deploy de produção implícito neste repositório.
