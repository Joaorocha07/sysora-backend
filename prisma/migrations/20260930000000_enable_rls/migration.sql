-- No Supabase, o schema public fica exposto pela Data API (PostgREST) para
-- quem tem a chave publicável, que vai no frontend. O Sysora só acessa o
-- banco pelo backend (Prisma, como dono das tabelas, que não passa pelo RLS),
-- então liga o RLS sem nenhuma política: a Data API não lê nem grava nada.
-- Em outros PostgreSQL (local, Neon...) isto não muda nada.
-- Tabela nova em migration futura: inclua o ENABLE ROW LEVEL SECURITY dela.
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_auth" ENABLE ROW LEVEL SECURITY;
