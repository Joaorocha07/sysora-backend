# Sysora — Backend

API do Sysora, um SaaS multiempresa de cadastro de clientes, serviços e agendamentos com um chatbot de WhatsApp conectado no estilo WhatsApp Web (QR Code).

**Stack:** Node.js, Express, TypeScript, Prisma (PostgreSQL), Baileys (WhatsApp Web), Zod e JWT.

## Rodando

O mais simples é usar `node iniciar.mjs` na pasta raiz (veja o README de lá). Ele cria o `.env` e um PostgreSQL local. Para fazer passo a passo:

```sh
npm install
cp .env.example .env          # preencha DATABASE_URL, segredos JWT e MASTER_*
npm run db:local              # (opcional) PostgreSQL local na porta 54329, noutro terminal
npx prisma migrate deploy     # cria as tabelas
npm run seed                  # cria o admin master (SEED_DEMO=true cria também uma empresa demo)
npm run dev                   # http://localhost:3333
```

Com `SEED_DEMO=true`: `admin@demo.sysora` / `funcionario@demo.sysora`, senha `demo12345`, plano Avançado e código de convite `DEMO2026`.

## Planos e assinatura

O plano pertence à **conta** (`Account`), não à empresa: no Avançado a mesma conta tem até 2 empresas, cada uma com o seu WhatsApp. Os limites e preços ficam em `src/lib/plans.ts`.

- `subscription.middleware.ts` responde **402** aos dados da empresa quando o teste ou o pagamento venceu. `/api/account` continua liberado, e o admin master sempre passa, para dar suporte.
- Com a assinatura vencida, o bot não responde e não envia lembretes.
- Rotas do cliente: `GET /api/account`, `POST /api/account/companies` (segunda empresa) e `PATCH /api/account/plan`.
- Rotas do master: `PATCH /api/admin/accounts/:id` (plano e status) e `POST /api/admin/accounts/:id/payment` (+30 dias).

## Cadastro público

- `POST /api/auth/register`: empresa nova (conta em teste grátis), o dono já entra como administrador.
- `POST /api/auth/register-employee`: pedido de acesso com o código de convite (`Company.inviteCode`). Fica `PENDING` até o admin aprovar em `/api/users/:id/approve`.
- `GET /api/auth/invite/:code`: nome da empresa do código, para conferir antes de enviar.
- Os cadastros têm um limite próprio de 10 por hora por IP.

## Perfis de acesso

| Perfil | Onde entra | O que faz |
| --- | --- | --- |
| **Admin master** (`User.isSuperAdmin`) | Painel master (sessão sem empresa) | Cria, edita, suspende e exclui empresas, define plano e limite de usuários, e entra em qualquer empresa como administrador |
| **Administrador** (`Role.ADMIN`) | Empresa | Tudo do funcionário, mais WhatsApp e bot, serviços, equipe, horários e dados da empresa |
| **Funcionário** (`Role.EMPLOYEE`) | Empresa | Agenda, clientes, conversas e consulta de serviços |

Quem tem acesso a mais de uma empresa escolhe qual abrir no login.

## Módulos (`src/modules`)

- `auth`: login, escolha/troca de empresa, refresh token opaco com rotação (cookie httpOnly), recuperação e troca de senha.
- `admin`: painel master (empresas e estatísticas).
- `users`: equipe da empresa, respeitando o limite do plano (`Company.maxUsers`).
- `clients`: cadastro de clientes (também criados automaticamente pelo bot).
- `services`: catálogo com duração, preço e ordem (a ordem é a mesma que o bot apresenta).
- `appointments`: agendamentos com vários serviços, horários livres (`availability.ts`), conflitos, remarcação e status.
- `conversations`: caixa de conversas do WhatsApp; a equipe responde e o bot pausa com aquele cliente.
- `whatsapp`: conexão por QR Code (`whatsapp.connection.ts`), chatbot (`whatsapp.bot.ts`) e tarefas periódicas (`whatsapp.jobs.ts`).
- `settings`, `dashboard`.

## Chatbot

Menu: **1) Agendar** (nome → serviços → dia → horário), **2) Meus agendamentos** (confirmar, remarcar, cancelar), **3) Serviços e valores**, **4) Falar com a equipe**. `0`, `menu` ou `voltar` voltam ao menu.

- Cadastra o cliente pela primeira mensagem e salva toda a conversa.
- Oferece só horários livres: respeita dias e horário de funcionamento, almoço, duração somada dos serviços e atendimentos simultâneos.
- Envia lembretes na véspera e pouco antes do horário, com confirmação por número.
- Fica em silêncio quando a equipe responde (pelo Sysora ou pelo celular) e volta após o prazo configurado.

Mensagens aceitam `{nome}`, `{empresa}`, `{servico}`, `{data}` e `{hora}`.

## Produção

- Rode **uma única instância** por banco: as sessões do WhatsApp ficam em memória no processo.
- Defina `TZ` com o fuso das empresas (padrão `America/Sao_Paulo`).
- Frontend e API em domínios diferentes: `CROSS_SITE_COOKIES=true` (cookie `SameSite=None; Secure`) e `CORS_ORIGIN` com a URL do frontend. Atrás de proxy, use `TRUST_PROXY=true`.
- As credenciais do WhatsApp são criptografadas com uma chave derivada de `JWT_REFRESH_SECRET`. Se ele mudar, cada empresa precisa ler o QR Code de novo.
# sysora-backend
