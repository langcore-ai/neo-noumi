FROM docker.io/cloudflare/sandbox:0.10.2

# 固定 Claude Code 版本，避免 latest 变化导致 CCR 行为不可复现。
ARG CLAUDE_CODE_VERSION=2.1.148

RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 \
	python3-pip \
	&& rm -rf /var/lib/apt/lists/* && pip install uv

# CCR 的真实执行进程运行在沙盒容器内，因此镜像需要内置 Claude Code CLI。
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
	&& claude --version

# 将仓库内置 skill 打入 Claude Code 默认 skill 目录。
COPY prompt/inner-skill/ /root/.claude/skills/
COPY prompt/CLAUDE.md /root/.claude/CLAUDE.md

# 本地开发需要 EXPOSE，方便沙盒内服务按需暴露端口。
EXPOSE 8080
