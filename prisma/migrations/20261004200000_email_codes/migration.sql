-- CreateTable
CREATE TABLE "email_inboxes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "senders" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_inboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_email_access" (
    "clientId" TEXT NOT NULL,
    "inboxId" TEXT NOT NULL,

    CONSTRAINT "client_email_access_pkey" PRIMARY KEY ("clientId","inboxId")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_inboxes_companyId_email_key" ON "email_inboxes"("companyId", "email");

-- CreateIndex
CREATE INDEX "client_email_access_inboxId_idx" ON "client_email_access"("inboxId");

-- AddForeignKey
ALTER TABLE "email_inboxes" ADD CONSTRAINT "email_inboxes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_email_access" ADD CONSTRAINT "client_email_access_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_email_access" ADD CONSTRAINT "client_email_access_inboxId_fkey" FOREIGN KEY ("inboxId") REFERENCES "email_inboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
