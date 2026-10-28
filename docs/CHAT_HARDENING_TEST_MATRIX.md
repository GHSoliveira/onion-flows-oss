# Chat Hardening Test Matrix

## Canais
- Telegram
- WhatsApp

## Fluxos criticos

### 1. Inicio simples
- Start -> Message -> Input -> Final
- Enviar duas mensagens seguidas rapidamente
- Esperado: sem reinicio indevido, sem duplicar chat, sem pular node

### 2. Command direto para final
- Command -> Final
- Enviar o comando em chat novo
- Esperado: executa o command e encerra sem passar pelo primeiro message node

### 3. Handoff para fila
- Bot -> Queue -> Pickup do agente -> Close com continue flow
- Esperado: pickup limpa runtime do bot, close retoma no resumeNodeId correto

### 4. Atendimento ativo
- Disparo ativo -> cliente responde -> agente envia mensagem -> agente encerra
- Esperado: continua no mesmo chat humano, sem criar chat bot paralelo, encerra com "Atendimento encerrado."

### 5. Delay duravel
- Start -> Message -> Delay(10s) -> Message
- Reiniciar backend antes do delay vencer
- Esperado: ao voltar, watcher retoma no proximo node apos o prazo

### 6. Timeout de node
- Input/Menu/Rating com timeout configurado
- Nao responder ate expirar
- Esperado: envia timeoutMessage e segue pela saida correta

### 7. Inatividade global
- Chat parado alem do limite global
- Esperado: envia mensagem de inatividade e fecha o chat

### 8. Midia inbound
- Enviar imagem/documento/audio
- Esperado: registra midia, nao corrompe estado do runtime

### 9. Status WhatsApp
- Enviar mensagem do agente
- Receber sent/delivered/read
- Esperado: status atualiza na mesma mensagem sem sobrescrever outras alteracoes do chat

### 10. Conflito operacional
- Enquanto webhook entra, agente envia mensagem e fecha o chat
- Esperado: sem perda de mensagem, sem estado impossivel, sem retorno a node antigo
