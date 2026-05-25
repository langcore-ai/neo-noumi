-- CreateTable
CREATE TABLE "ai_proxy_request_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "credentialId" TEXT,
    "provider" TEXT NOT NULL,
    "requestMethod" TEXT NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "requestPath" TEXT NOT NULL,
    "upstreamUrl" TEXT NOT NULL,
    "upstreamBaseUrl" TEXT NOT NULL,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "requestBytes" INTEGER NOT NULL,
    "responseBytes" INTEGER,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_proxy_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_proxy_request_log_payloads" (
    "id" TEXT NOT NULL,
    "logId" TEXT NOT NULL,
    "requestHeaders" JSONB NOT NULL,
    "requestBody" TEXT,
    "upstreamRequestHeaders" JSONB NOT NULL,
    "responseHeaders" JSONB,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_proxy_request_log_payloads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_proxy_request_logs_userId_startedAt_idx" ON "ai_proxy_request_logs"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ai_proxy_request_logs_sessionId_startedAt_idx" ON "ai_proxy_request_logs"("sessionId", "startedAt");

-- CreateIndex
CREATE INDEX "ai_proxy_request_logs_statusCode_startedAt_idx" ON "ai_proxy_request_logs"("statusCode", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_proxy_request_log_payloads_logId_key" ON "ai_proxy_request_log_payloads"("logId");

-- AddForeignKey
ALTER TABLE "ai_proxy_request_logs" ADD CONSTRAINT "ai_proxy_request_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proxy_request_logs" ADD CONSTRAINT "ai_proxy_request_logs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proxy_request_logs" ADD CONSTRAINT "ai_proxy_request_logs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ai_proxy_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proxy_request_logs" ADD CONSTRAINT "ai_proxy_request_logs_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ai_proxy_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proxy_request_log_payloads" ADD CONSTRAINT "ai_proxy_request_log_payloads_logId_fkey" FOREIGN KEY ("logId") REFERENCES "ai_proxy_request_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
