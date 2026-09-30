-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicSignupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- Fora da Data API do Supabase (veja a migration enable_rls).
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
