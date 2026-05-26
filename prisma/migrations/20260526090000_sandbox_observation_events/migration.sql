-- 记录 sandbox 容器主进程观测到的心跳、资源用量和信号事件。
CREATE TABLE "sandbox_observation_events" (
    "id" SERIAL NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "containerId" TEXT,
    "eventType" TEXT NOT NULL,
    "sequence" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_observation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sandbox_observation_events_sandboxId_observedAt_idx"
ON "sandbox_observation_events"("sandboxId", "observedAt");

CREATE INDEX "sandbox_observation_events_eventType_observedAt_idx"
ON "sandbox_observation_events"("eventType", "observedAt");
