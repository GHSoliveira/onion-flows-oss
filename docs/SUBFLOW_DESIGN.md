# Desenho de subfluxos (Fase B, nao implementada)

Esta proposta nao altera o runtime atual. A implementacao depende de aprovacao explicita.

## Estado do chat

O chat teria uma pilha `flowCallStack` com `{ flowId, version, returnNodeId, callerVars }`. Cada chamada usaria o snapshot publicado e a versao resolvida no momento da entrada. O retorno restauraria o fluxo chamador e seguiria em `returnNodeId`.

## Limites e recursao

- Profundidade maxima sugerida: 8.
- Antes da chamada, rejeitar um `flowId` que ja exista na pilha.
- Fluxo ausente, despublicado ou sem inicio segue uma saida de erro explicita do node chamador.

## Republicacao

Chats em execucao permanecem na versao resolvida ao entrar no subfluxo. Novas chamadas usam a versao publicada mais recente. Rollback nao troca silenciosamente o snapshot de chats vivos.

## Variaveis

O node define entradas e saidas declarativas. `vars` sao copiadas somente pelos mapeamentos configurados. `secureVars` nunca retornam automaticamente e so podem ser consumidas internamente por nomes previamente autorizados.

## Cache

A chave deve incluir `tenantId + flowId + version`. Publicacao e rollback invalidam apenas novas resolucoes; entradas ativas mantem o snapshot versionado ate retornar.

## Falhas

Timeout, profundidade, recursao e subfluxo indisponivel devem produzir eventos de auditoria sem dados secretos e seguir uma saida `error` configuravel.
