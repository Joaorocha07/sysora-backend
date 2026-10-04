-- Tabelas de códigos por e-mail fora da Data API do Supabase (ver 20260930000000_enable_rls).
ALTER TABLE "email_inboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_email_access" ENABLE ROW LEVEL SECURITY;
