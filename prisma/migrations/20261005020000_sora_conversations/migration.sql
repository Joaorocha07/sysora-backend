-- CreateTable
CREATE TABLE "sora_conversations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sora_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sora_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sora_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sora_conversations_companyId_updatedAt_idx" ON "sora_conversations"("companyId", "updatedAt");

-- CreateIndex
CREATE INDEX "sora_messages_conversationId_createdAt_idx" ON "sora_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "sora_conversations" ADD CONSTRAINT "sora_conversations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sora_conversations" ADD CONSTRAINT "sora_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sora_messages" ADD CONSTRAINT "sora_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "sora_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Fora da Data API do Supabase (ver 20260930000000_enable_rls).
ALTER TABLE "sora_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sora_messages" ENABLE ROW LEVEL SECURITY;
