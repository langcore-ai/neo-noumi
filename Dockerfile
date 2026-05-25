FROM docker.io/cloudflare/sandbox:0.10.2

# 固定 Claude Code 版本，避免 latest 变化导致 CCR 行为不可复现。
ARG CLAUDE_CODE_VERSION=2.1.148

# CCR 的真实执行进程运行在沙盒容器内，因此镜像需要内置 Claude Code CLI。
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
	&& claude --version

# Claude Code 和用户命令统一以非 root 用户运行，避免把运行期状态写入 /root。
RUN groupadd --gid 10001 noumi \
	&& useradd --uid 10001 --gid 10001 --create-home --shell /bin/sh noumi \
	&& mkdir -p /home/noumi/.claude \
	&& mkdir -p /home/noumi/workspace \
	&& chown -R noumi:noumi /home/noumi

# 本地开发需要 EXPOSE，方便沙盒内服务按需暴露端口。
EXPOSE 8080
