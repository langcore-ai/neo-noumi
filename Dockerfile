# syntax=docker/dockerfile:1.7

FROM docker.io/oven/bun:1.3.14 AS observer-builder

WORKDIR /build

COPY code-sandbox/package.json code-sandbox/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --production

COPY code-sandbox/main.ts ./main.ts
RUN bun build ./main.ts \
	--compile \
	--outfile /build/neo-noumi-sandbox-observer

FROM docker.io/cloudflare/sandbox:0.10.2

# 固定 Claude Code 版本，避免 latest 变化导致 CCR 行为不可复现。
ARG CLAUDE_CODE_VERSION=2.1.148

# 让 BuildKit 缓存 apt 下载包；Docker 官方基础镜像默认会清理 apt cache。
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
	&& echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' \
		> /etc/apt/apt.conf.d/keep-cache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
	--mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
	apt-get update && apt-get install -y --no-install-recommends \
		curl \
		poppler-utils \
		python3 \
		python3-pip \
		wget

RUN --mount=type=cache,target=/root/.cache/pip \
	pip install uv \
	&& uv pip install --system reportlab pdfplumber pypdf

# CCR 的真实执行进程运行在沙盒容器内，因此镜像需要内置 Claude Code CLI。
RUN --mount=type=cache,target=/root/.npm \
	npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
	&& claude --version

# 将仓库内置 skill 打入 Claude Code 默认 skill 目录。
COPY prompt/inner-skill/ /root/.claude/skills/
COPY prompt/CLAUDE.md /root/.claude/CLAUDE.md

COPY --from=observer-builder /build/neo-noumi-sandbox-observer /usr/local/bin/neo-noumi-sandbox-observer

# 本地开发需要 EXPOSE，方便沙盒内服务按需暴露端口。
EXPOSE 8080

# 保留 Cloudflare Sandbox SDK 镜像的 ENTRYPOINT；CMD 会作为子进程运行并接收信号转发。
CMD ["/usr/local/bin/neo-noumi-sandbox-observer"]
