-- AlterTable
ALTER TABLE "users" ADD COLUMN "avatarUrl" TEXT,
ADD COLUMN "googleLinkedAt" TIMESTAMP(3),
ADD COLUMN "lastLoginAt" TIMESTAMP(3);
