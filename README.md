# Integração PIX da campanha

O checkout do `index.html` chama as funções serverless da Vercel. A chave ObyPay permanece no servidor e nunca é enviada ao navegador.

## Fluxo

- `POST /api/charges` valida os dados, registra o pedido em `vaquinha_donation_orders` e envia a cobrança a `POST https://api.obypay.app/transactions`.
- A requisição ObyPay usa o header `Authorization` com a chave crua, sem `Bearer`, e os campos documentados `amount` (centavos), `webhook`, `description`, `externalId`, `storeUrl`, `customer` e `products`.
- O `externalId` é o UUID do pedido local. Uma reserva atômica no banco impede que duas solicitações simultâneas criem cobranças duplicadas. A API não envia headers de idempotência que não estejam documentados. Em caso de timeout ou falha ambígua, a reserva permanece ativa para bloquear nova tentativa automática; reconcilie a transação no painel ObyPay antes de liberar o pedido.
- A resposta mapeia `id`, `amount`, `copyPaste`, `qrCodeBase64` e `expiresAt`. O código Copia e Cola é salvo no banco; usa-se o QR Code recebido ou, se ausente, ele é gerado a partir do código PIX.
- `GET /api/charges/{orderId}` lê o status local e não consulta a ObyPay em loop. O webhook assinado é a fonte primária de confirmação.
- `POST /api/webhook` valida `obypay-signature` usando HMAC-SHA256 sobre os bytes originais do corpo. Só o evento documentado `payment.approved`, com `data.id`, `data.externalId` e o `data.amount` esperado em centavos, pode marcar a contribuição como paga. Reentregas são deduplicadas no banco. O `webhook.test` é respondido sem alterar pedidos.
- Erros do provedor são registrados no servidor com HTTP, código e mensagem redigida. A resposta ao navegador é genérica e não inclui a mensagem interna do provedor.

## Dinheiro e taxas

Os valores exibidos pela campanha são reais inteiros e são convertidos uma vez para centavos inteiros ao montar a solicitação. A ObyPay documenta mínimo de 50 centavos e exige que o valor da cobrança seja maior que a soma das taxas da conta. As taxas e limites são específicos da conta; a API ObyPay é quem aplica essa validação. Em caso de HTTP 400, o checkout orienta conferir os dados e tentar valor maior. Não cobramos taxa por fora nem alteramos o valor selecionado.

## Banco e migrações

O banco PostgreSQL/Neon existente é conectado por `DATABASE_URL` ou, quando fornecida pela integração do Vercel/Neon, `POSTGRES_URL` (`DATABASE_URL` tem precedência). Os pedidos usam tabelas próprias com prefixo `vaquinha_`.

- `migrations/001_create_vaquinha_donation_tables.sql`: tabelas de pedidos e eventos webhook.
- `migrations/002_add_charge_creation_claim.sql`: coluna aditiva que reserva a criação de uma cobrança e evita duplicatas concorrentes. A migração usa `ADD COLUMN IF NOT EXISTS` e não remove dados.

Antes do deploy, abra o projeto/branch Neon usado pelo `POSTGRES_URL` ou `DATABASE_URL`, entre em **SQL Editor**, cole o conteúdo de `migrations/002_add_charge_creation_claim.sql` e execute. A operação só adiciona a coluna; não apaga nem altera contribuições existentes. Não execute novamente a migration 001 se as tabelas já existem.

## Variáveis da Vercel

Em **Project → Settings → Environment Variables**, configure para Production (e Preview, se necessário):

- `OBYPAY_API_KEY`: usada em `api/_lib/obypay.js`; chave com o escopo `payments.create` e, para leitura de transações, `payments.read`. O código envia-a crua no header `Authorization`.
- `OBYPAY_WEBHOOK_SECRET`: usada em `api/webhook.js` para validar a assinatura do webhook.
- `DATABASE_URL` ou `POSTGRES_URL`: usadas em `api/_lib/db.js` para conectar ao banco existente. O projeto Vercel conectado ao Neon já fornece `POSTGRES_URL`; configure `DATABASE_URL` somente se preferir usar uma URL específica.
- `APP_URL`: usada em `api/_lib/campaign.js` para construir `webhook = <APP_URL>/api/webhook` e `storeUrl = <APP_URL>`. Deve ser apenas a origem HTTPS pública do domínio de produção, sem caminho, query ou fragmento.

Para este deploy, a URL pública da aplicação é `https://vaquinhaonlline-6u93.vercel.app`; configure `APP_URL` com essa origem exata. Nunca use prefixo `NEXT_PUBLIC_` nos segredos e não os coloque em commits, frontend ou mensagens.

No painel ObyPay, configure um webhook ativo para `<APP_URL>/api/webhook` com o evento `payment.approved`; copie a secret do webhook para `OBYPAY_WEBHOOK_SECRET`. A API ObyPay documenta também chamadas HTTP `GET /transactions/:id` para reconciliação manual; nenhuma cobrança real é criada pela suíte de testes.

## Verificações e publicação

Execute `npm test` para rodar testes locais com respostas simuladas. `vercel build --prod` valida o pacote das funções sem criar cobranças. Não rode testes de cobrança contra produção.

O projeto foi configurado para a raiz do repositório na Vercel, com preset **Other**. Os valores de meta, arrecadação e contadores continuam estáticos e não são alterados automaticamente pelos pagamentos.
