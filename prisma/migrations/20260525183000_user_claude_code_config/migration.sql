-- CreateTable
-- 用户级 Claude Code 配置；两个 JSONB 字段分别对应 ~/.claude/config.json 和 ~/.claude.json。
CREATE TABLE "user_claude_code_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claudeConfigJson" JSONB NOT NULL DEFAULT '{}',
    "claudeJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_claude_code_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_claude_code_configs_userId_key" ON "user_claude_code_configs"("userId");

-- AddForeignKey
ALTER TABLE "user_claude_code_configs" ADD CONSTRAINT "user_claude_code_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
