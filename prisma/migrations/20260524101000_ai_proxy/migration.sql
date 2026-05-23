-- CreateTable
CREATE TABLE "ai_proxy_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "baseUrl" TEXT NOT NULL,
    "apiKeyCiphertext" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "ai_proxy_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_proxy_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_proxy_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_proxy_credentials_userId_isDefault_idx" ON "ai_proxy_credentials"("userId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "ai_proxy_tokens_tokenHash_key" ON "ai_proxy_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "ai_proxy_tokens_userId_expiresAt_idx" ON "ai_proxy_tokens"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_proxy_tokens_sessionId_revokedAt_idx" ON "ai_proxy_tokens"("sessionId", "revokedAt");

-- AddForeignKey
ALTER TABLE "ai_proxy_credentials" ADD CONSTRAINT "ai_proxy_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proxy_tokens" ADD CONSTRAINT "ai_proxy_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proxy_tokens" ADD CONSTRAINT "ai_proxy_tokens_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
