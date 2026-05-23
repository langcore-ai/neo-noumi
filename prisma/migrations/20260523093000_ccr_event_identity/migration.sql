-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "nextClientSequence" INTEGER NOT NULL DEFAULT 1;

-- BackfillSequence
UPDATE "chat_sessions" AS chat_session
SET "nextClientSequence" = COALESCE(
	(
		SELECT MAX(event."sequenceNum") + 1
		FROM "chat_client_events" AS event
		WHERE event."sessionId" = chat_session."id"
	),
	1
);

-- DropIndex
DROP INDEX IF EXISTS "chat_client_events_eventId_key";
DROP INDEX IF EXISTS "chat_worker_events_eventId_key";
DROP INDEX IF EXISTS "chat_internal_events_eventId_key";

-- CreateIndex
CREATE INDEX "chat_client_events_sessionId_status_sequenceNum_idx" ON "chat_client_events"("sessionId", "status", "sequenceNum");

-- CreateIndex
CREATE UNIQUE INDEX "chat_client_events_sessionId_eventId_key" ON "chat_client_events"("sessionId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_worker_events_sessionId_eventId_key" ON "chat_worker_events"("sessionId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_internal_events_sessionId_eventId_key" ON "chat_internal_events"("sessionId", "eventId");
