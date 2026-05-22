-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "username" TEXT,
    "displayUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workerEpoch" INTEGER NOT NULL DEFAULT 0,
    "workerStatus" TEXT NOT NULL DEFAULT 'idle',
    "containerStatus" TEXT NOT NULL DEFAULT 'stopped',
    "sandboxId" TEXT,
    "runnerProcessId" TEXT,
    "workerAccessToken" TEXT,
    "externalMetadata" JSONB NOT NULL DEFAULT '{}',
    "requiresActionDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_containers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sandboxId" TEXT,
    "containerStatus" TEXT NOT NULL DEFAULT 'stopped',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_client_events" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sequenceNum" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_client_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_worker_events" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "workerEpoch" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "ephemeral" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_worker_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_internal_events" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "workerEpoch" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "eventMetadata" JSONB,
    "isCompaction" BOOLEAN NOT NULL DEFAULT false,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_internal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_delivery_updates" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "workerEpoch" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_delivery_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_operation_log" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "eventId" TEXT,
    "agentId" TEXT,
    "toolName" TEXT,
    "toolUseId" TEXT,
    "requestId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_operation_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_session_store_files" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "subpath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_session_store_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "projects_userId_updatedAt_idx" ON "projects"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "chat_sessions_userId_updatedAt_idx" ON "chat_sessions"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "chat_sessions_projectId_updatedAt_idx" ON "chat_sessions"("projectId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_containers_userId_key" ON "user_containers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_client_events_eventId_key" ON "chat_client_events"("eventId");

-- CreateIndex
CREATE INDEX "chat_client_events_sessionId_sequenceNum_idx" ON "chat_client_events"("sessionId", "sequenceNum");

-- CreateIndex
CREATE UNIQUE INDEX "chat_client_events_sessionId_sequenceNum_key" ON "chat_client_events"("sessionId", "sequenceNum");

-- CreateIndex
CREATE UNIQUE INDEX "chat_worker_events_eventId_key" ON "chat_worker_events"("eventId");

-- CreateIndex
CREATE INDEX "chat_worker_events_sessionId_id_idx" ON "chat_worker_events"("sessionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_internal_events_eventId_key" ON "chat_internal_events"("eventId");

-- CreateIndex
CREATE INDEX "chat_internal_events_sessionId_agentId_id_idx" ON "chat_internal_events"("sessionId", "agentId", "id");

-- CreateIndex
CREATE INDEX "chat_delivery_updates_sessionId_eventId_idx" ON "chat_delivery_updates"("sessionId", "eventId");

-- CreateIndex
CREATE INDEX "chat_operation_log_sessionId_id_idx" ON "chat_operation_log"("sessionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_session_store_files_sessionId_projectKey_subpath_key" ON "chat_session_store_files"("sessionId", "projectKey", "subpath");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_containers" ADD CONSTRAINT "user_containers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_client_events" ADD CONSTRAINT "chat_client_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_worker_events" ADD CONSTRAINT "chat_worker_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_internal_events" ADD CONSTRAINT "chat_internal_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_delivery_updates" ADD CONSTRAINT "chat_delivery_updates_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_operation_log" ADD CONSTRAINT "chat_operation_log_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_session_store_files" ADD CONSTRAINT "chat_session_store_files_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
