-- Fluxo do chatbot montado pela empresa (menus, mensagens e funções).
-- Nulo = menu padrão.
ALTER TABLE "company_settings" ADD COLUMN "botFlow" JSONB;
