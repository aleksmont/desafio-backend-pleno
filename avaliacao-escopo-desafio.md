# Avaliação de aderência ao desafio Backend Pleno

**A versão analisada (`7eea94b`) está dentro do escopo descrito no [desafio da Buzzmates](https://github.com/buzzmates/desafio-backend-pleno).** Não foram identificados novos desvios funcionais nesta revisão.

Repositório da implementação: [aleksmont/desafio-backend-pleno](https://github.com/aleksmont/desafio-backend-pleno).

## Comparação com os requisitos

| Requisito | Situação |
| --- | --- |
| NestJS, webhook e validação | Atendido |
| Idempotência e persistência inicial `RECEIVED` | Atendido |
| Fila e processamento assíncrono | Atendido com SQLite |
| Enriquecimento externo | Consultado também para pedidos na mesma moeda |
| Retry com backoff antes da DLQ | Corrigido |
| Status `FAILED_ENRICHMENT` após esgotar tentativas | Atendido |
| Consulta, filtro por status e métricas | Atendido |
| Testes do processamento e transições | Cobertos pela suíte |

## Funcionalidades adicionais

Os extras são pertinentes: testes adicionais, CI, análise estática, precisão decimal e recuperação após falhas apoiam o requisito de boas práticas.

## Escolha arquitetural

A principal escolha a defender na apresentação continua sendo a fila própria em SQLite. Ela acrescenta complexidade de implementação, mas o enunciado não exige BullMQ, Redis ou RabbitMQ. A justificativa e os limites estão documentados no README da implementação.

## Recomendação

Manter o escopo atual, sem acrescentar funcionalidades.

Esta avaliação trata da aderência ao enunciado na versão indicada. Nenhum arquivo da implementação foi alterado durante a revisão.
