# Integração PIX da campanha

A página usa o HTML e o CSS originais da campanha. O checkout envia pedidos às funções serverless da Vercel; as chamadas ao ObyPay usam exclusivamente `process.env.OBYPAY_API_KEY` no servidor.

## O que mudou

- O checkout no `index.html` continua chamando `POST /api/charges` e consulta o estado em `GET /api/charges/{orderId}`.
- `api/_lib/obypay.js` implementa a API oficial do ObyPay. A chave vai no header `Authorization`, sem prefixo `Bearer`, e a cobrança usa valores em centavos; a resposta esperada contém `transactionId`, `copyPaste` e `expiresAt`.
- `api/charges.js`, `api/charges/[orderId].js` e `api/webhook.js` criam/consultam cobranças e recebem eventos assinados ao padrão ObyPay.
- `api/_lib/webhook-signature.js` valida o HMAC-SHA256 do corpo bruto com comparação em tempo constante.
- `api/_lib/db.js` conecta ao Neon usando `DATABASE_URL`. Os pedidos da campanha usam tabelas PostgreSQL próprias, com prefixo `vaquinha_`, sem alterar tabelas existentes.
- `migrations/001_create_vaquinha_donation_tables.sql` cria as tabelas de pedidos e eventos idempotentes.
- A criação reutiliza a mesma `Idempotency-Key` e faz no máximo uma repetição para erros transitórios. Para HTTP 429, não repete antes do prazo: encaminha `Retry-After` ao cliente.

## Schema e migração

O projeto Vercel de produção usa `DATABASE_URL` e o domínio público do projeto como `APP_URL`. Antes do deploy, confirme que a conexão `DATABASE_URL` de Production aponta para o mesmo banco e branch. Não execute novamente a migration se as tabelas já existem.

Não rode testes de cobrança contra o ambiente de produção. A suíte local usa respostas simuladas e não cria cobranças.

## Variáveis na Vercel

Configure em **Project → Settings → Environment Variables** para Production (e Preview, se for testar lá):

- `DATABASE_URL`: fornecida pela integração Neon conectada ao projeto.
- `OBYPAY_API_KEY`: chave de API gerada em **Integrações → Credenciais** no painel ObyPay.
- `OBYPAY_WEBHOOK_SECRET`: secret do webhook ObyPay; é diferente da chave de API e necessário para autenticar callbacks.
- `APP_URL`: origem pública HTTPS estável do projeto confirmado, sem barra final.

Não use um prefixo `NEXT_PUBLIC_` para segredos. Não compartilhe essas credenciais em commits, capturas de tela ou mensagens. `.env.example` contém apenas nomes das variáveis, sem valores.

No ObyPay, configure a callback como `<APP_URL>/api/webhook`, usando o domínio público efetivo do projeto. A função verifica a assinatura `obpay-signature` sobre os bytes originais, confere ID e valor do pedido, e deduplica eventos por transação e tipo. O polling é mantido como alternativa ao webhook.

Se o checkout receber HTTP 405 em `POST /api/charges`, confira se a Vercel está usando a raiz do repositório (onde está a pasta `api/`) como **Root Directory** e faça um novo deploy incluindo as funções serverless. A função responde JSON quando é executada; um 405 vazio normalmente indica que a requisição não chegou à função.

## Testes e publicação

Rode `npm install` e `npm test`. Os testes fazem mocks locais e não geram cobranças reais. Confira também `npm audit --omit=dev`.

Depois de executar a migração e configurar todas as variáveis, publique o commit na branch vinculada à Vercel ou aguarde o deploy automático do GitHub. Verifique o build e os logs das funções. O teste final de pagamento deve usar o ambiente e o procedimento de testes autorizados pelo gateway; não use uma cobrança real sem autorização.

Os valores da meta, arrecadação e contadores permanecem os mesmos do HTML original. A API registra os pedidos e status de pagamento, mas não atualiza automaticamente esses números exibidos na página.
