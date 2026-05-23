# Claude CCR v2 远程模式设计记录

## 背景

本文记录基于 `claude-code-reverse` 源码梳理出的 CCR v2 协议、`--sdk-url` 远程模式启用方式，以及当前关于 A/B 机器职责拆分的初步结论。

注意：`/v1/code/sessions/{sessionId}/worker/*` 这组 worker 协议没有找到公开官方 schema 文档。以下格式来自源码反推，适合作为 POC 实现参考，不应当视为稳定公开 API。

## 核心结论

- `spawnClaudeCodeProcess` 和 CCR v2 不是同一套东西。
- `spawnClaudeCodeProcess` 是 Agent SDK 的进程启动 hook，关注如何启动 Claude Code CLI 进程以及如何桥接 stdin/stdout/stderr。
- CCR v2 是 Claude Code CLI 启动后使用的远程 session transport，关注 CLI 如何通过 SSE/HTTP POST 和远端 session service 交换事件。
- `claude --print --sdk-url ...` 不会把文件读写、Bash、内置 tools 变成 RPC；这些操作仍在 Claude Code 进程所在机器执行。
- 当前 remote-control 模型可近似理解为：一个活跃 session 对应一个 Claude Code CLI 子进程。
- 如果 B 是执行容器，B 必须具备 Claude Code CLI、workspace、`.claude/skills`、`CLAUDE.md`、`.mcp.json`、settings 和项目工具链。
- A 上需要执行的外部工具，不应接管 `Read/Edit/Bash` 等内置工具；应建成单独外部工具通道，并通过 CCR 事件或 MCP/RPC 让 B 等待并接收结果。

## 当前业务化落地

- 数据模型已拆成 `projects`、`chat_sessions`、`user_containers`：一个用户可以有多个 project，session 必须归属某个用户和某个 project。
- `chat_sessions.userId` 和 `chat_sessions.projectId` 是非空外键，创建 session 前会校验 project 属于当前登录用户，避免跨用户挂载 session。
- Cloudflare 资源使用 `NeoNoumiSandbox` / `NEO_NOUMI_SANDBOX` / `neo-noumi-sandbox` 命名，用户级 sandbox ID 使用 `neo-noumi-user-{userId}`。
- 容器粒度是“一个用户一个 sandbox/container”，而不是“一个 session 一个容器”。
- runner 粒度仍是“一个活跃 session 一个 Claude Code CLI 进程”；`chat_sessions.runnerProcessId` 记录 session 对应的容器内进程，防止同一用户多个 session 互相复用错 runner。
- 删除活跃 session 时只停止该 session 的 runner；session 级 stop 也只停止该 session 记录的 runner，并同步清理 `runnerProcessId` 与 session 容器状态。destroy 仍作用于当前用户的整个 sandbox，但必须先校验 URL 中的 session 属于当前用户。

## 两套机制的关系

### spawnClaudeCodeProcess

Agent SDK 场景下：

```text
A Agent SDK query()
  -> spawnClaudeCodeProcess(command, args, cwd, env, signal)
    -> 返回 ChildProcess-like 对象
```

它的职责是进程生命周期：

- 启动 Claude Code CLI。
- 写入 stdin。
- 读取 stdout/stderr。
- 处理 close/error。
- 处理 kill/abort。

### CCR v2

CCR v2 场景下：

```text
B claude --print --sdk-url https://A/v1/code/sessions/{sessionId}
  -> RemoteIO
    -> GET  /worker/events/stream
    -> POST /worker/events
    -> POST /worker/internal-events
    -> PUT  /worker
```

它的职责是 session transport：

- 从远端读取用户消息和控制事件。
- 向远端写 assistant/result/stream events。
- 持久化 internal events。
- 上报 worker 状态和 heartbeat。
- 处理 worker epoch 替换。

## 远程模式启用方式

Claude Code 子进程启动参数形态：

```text
claude --print \
  --sdk-url https://A/v1/code/sessions/{sessionId} \
  --session-id {sessionId} \
  --input-format stream-json \
  --output-format stream-json \
  --replay-user-messages
```

CCR v2 相关环境变量：

```text
CLAUDE_CODE_ENVIRONMENT_KIND=bridge
CLAUDE_CODE_USE_CCR_V2=1
CLAUDE_CODE_WORKER_EPOCH={workerEpoch}
CLAUDE_CODE_SESSION_ACCESS_TOKEN={workerJwt}
```

### Claude Code 版本约束

本地 CCR route 测试需要 Claude Code CLI 接受非官方 `--sdk-url`，例如：

```text
http://localhost:3021/v1/code/sessions/{sessionId}
```

基于 `bun add @anthropic-ai/claude-code@{version}` 的隔离安装探针，已定位 `--sdk-url` host 白名单逻辑的引入边界：

| 版本 | `--sdk-url http://localhost:3021/...` 行为 |
| --- | --- |
| `2.1.117` | 未出现 host 白名单拒绝 |
| `2.1.118` | 未出现 host 白名单拒绝 |
| `2.1.119` | 未出现 host 白名单拒绝 |
| `2.1.120` | 未出现 host 白名单拒绝 |
| `2.1.121` | 拒绝：`host "localhost" is not an approved Anthropic endpoint` |
| `2.1.122` | 拒绝：`host "localhost" is not an approved Anthropic endpoint` |
| `2.1.131` | 拒绝：`host "localhost" is not an approved Anthropic endpoint` |
| `2.1.145` | 拒绝：`host "localhost" is not an approved Anthropic endpoint` |

结论：

- 最后一个可用于本地 `--sdk-url` CCR route 测试的已验证版本是 `2.1.120`。
- 第一个引入 `--sdk-url` host 白名单拒绝的已验证版本是 `2.1.121`。
- 本项目做本地 CCR route 闭环测试时应固定使用 `@anthropic-ai/claude-code@2.1.120` 的隔离安装版本，不应使用全局最新版。
- `2.1.121+` 的官方 CLI 只允许受认可的 Anthropic endpoint；已验证 `2.1.145` 可以通过 Docker `--add-host` 把允许域名指向本地 HTTPS 入口，再设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过自签证书校验进入 CCR 握手。

探针命令形态：

```text
bun add @anthropic-ai/claude-code@{version}
CLAUDE_CODE_USE_CCR_V2=1 \
CLAUDE_CODE_WORKER_EPOCH=1 \
CLAUDE_CODE_SESSION_ACCESS_TOKEN=x \
claude --print \
  --sdk-url http://localhost:3021/v1/code/sessions/00000000-0000-4000-8000-000000000001 \
  --session-id 00000000-0000-4000-8000-000000000001 \
  --input-format stream-json \
  --output-format stream-json \
  --verbose
```

判断标准：如果输出包含 `--sdk-url rejected` 或 `not an approved Anthropic endpoint`，说明该版本已经引入 host 白名单拒绝。

### Docker 允许域名绕过探针

`2.1.145` 的拒绝点不是 CCR route 协议，而是 CLI 连接前的 host allowlist 和 TLS 校验。按以下方式验证过：

1. 启动现有 Bun route 的 HTTPS 入口：`CCR_SQLITE_PATH=/tmp/claude-ccr-docker.sqlite bun run dev:https`。
2. `dev:https` 读取 `.local/tls/beacon.claude-ai.staging.ant.dev.key` 和 `.local/tls/beacon.claude-ai.staging.ant.dev.crt`，并监听 `3443`；证书 CN/SAN 包含 `beacon.claude-ai.staging.ant.dev`。
3. 容器内运行 `@anthropic-ai/claude-code-linux-arm64@2.1.145`，并使用 `--add-host=beacon.claude-ai.staging.ant.dev:host-gateway`。

对照结果：

- `--sdk-url http://localhost:3021/...` 仍被拒绝：`host "localhost" is not an approved Anthropic endpoint`。
- 使用允许域名和 `--add-host` 后，错误推进到 `DEPTH_ZERO_SELF_SIGNED_CERT`，说明 host allowlist 已通过。
- 加上 `NODE_TLS_REJECT_UNAUTHORIZED=0` 并先注册匹配的 `worker_epoch` 后，CLI 输出 `SSE connected` 和 `worker registered`。

最小命令形态：

```text
curl -sk -X POST https://localhost:3443/v1/code/sessions/{sessionId}/worker/register

docker run --rm \
  --add-host=beacon.claude-ai.staging.ant.dev:host-gateway \
  -v /tmp/claude-code-linux-arm64-2.1.145/package:/claude:ro \
  ubuntu:latest bash -lc '
    NODE_TLS_REJECT_UNAUTHORIZED=0 \
    CLAUDE_CODE_USE_CCR_V2=1 \
    CLAUDE_CODE_WORKER_EPOCH=1 \
    CLAUDE_CODE_SESSION_ACCESS_TOKEN=x \
    /claude/claude --print \
      --sdk-url https://beacon.claude-ai.staging.ant.dev:3443/v1/code/sessions/{sessionId} \
      --session-id {sessionId} \
      --input-format stream-json \
      --output-format stream-json \
      --verbose
  '
```

### Cloudflare Containers outbound interception 路径

Cloudflare Containers 的 outbound interception 可以把本地 Docker 探针里的 `--add-host + HTTPS 包装层 + NODE_TLS_REJECT_UNAUTHORIZED=0` 替换成平台内置的出站代理能力。目标链路是：

```text
Claude Code CLI in Cloudflare Container
  -> https://beacon.claude-ai.staging.ant.dev/v1/code/sessions/{sessionId}
  -> Cloudflare outbound HTTPS interception
  -> Worker outboundByHost handler
  -> CCR route /v1/code/sessions/{sessionId}
```

从官方文档确认到的硬条件：

- 容器类需要 `interceptHttps = true`，否则 HTTPS 请求默认不会进入 outbound handler。
- Worker entrypoint 必须 `export { ContainerProxy }`，否则 outbound interception 不生效。
- 如果设置 `allowedHosts`，必须把 `beacon.claude-ai.staging.ant.dev` 放入 allowlist；`allowedHosts` 会先于 handler 判定。
- HTTPS 拦截启用后，Cloudflare 会在运行时注入 `/etc/cloudflare/certs/cloudflare-containers-ca.crt`，容器 entrypoint 需要把它加入系统 trust store，或通过 `NODE_EXTRA_CA_CERTS` 让 Node/Claude Code 信任它。
- outbound handler 只拦截 HTTP/HTTPS；非 80/443 流量不会进入 handler。
- 容器磁盘是 ephemeral，实例休眠后会从镜像 fresh disk 重启；workspace、Claude transcript、`.claude/skills`、settings 等持久化不能依赖容器本地盘。

推荐 POC 形态：

```ts
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers'

export { ContainerProxy }

export class ClaudeWorkerContainer extends Container {
  defaultPort = 8080
  enableInternet = false
  interceptHttps = true
  allowedHosts = ['beacon.claude-ai.staging.ant.dev']

  entrypoint = [
    'sh',
    '-lc',
    [
      'cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt',
      'update-ca-certificates',
      'export NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      'exec node server.js',
    ].join(' && '),
  ]

  static outboundByHost = {
    'beacon.claude-ai.staging.ant.dev': async (request, env) => {
      return env.CCR_ROUTE.fetch(request)
    },
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.CLAUDE_CONTAINER, 'ccr-session')
    return container.fetch(request)
  },
}
```

真实接入时，`outboundByHost` 应把 request 映射到受控 CCR route：

- 如果 CCR route 也在同一个 Worker 内，handler 直接调用内部 Hono/Worker handler。
- 如果 CCR route 是另一个 Worker Service Binding，handler 调用对应 binding。
- 如果 CCR route 在外部 HTTPS 服务，handler 负责重写 upstream，同时保留 path、method、headers、body 和 SSE streaming。

这个方案理论上比 Docker `--add-host` 更顺，因为 Claude Code 仍请求 approved host，而域名映射、TLS 中间人证书和出站代理都由 Cloudflare 平台提供。当前仍必须实测的风险点：

- Claude Code `2.1.145+` 是否完全信任 Cloudflare 注入 CA；若系统 trust store 不生效，需要确认 `NODE_EXTRA_CA_CERTS` 是否被它使用。
- `GET /worker/events/stream` 的 SSE 长连接在 outbound HTTPS handler 中是否保持流式转发，不被缓冲或过早关闭。
- `POST /worker/events`、`/internal-events`、`/events/delivery`、`/heartbeat` 在 handler 重写后是否保持原始 body 和认证头。
- 容器休眠、冷启动和 rolling deploy 时，Claude Code worker epoch、sessionStore、workspace 和 route 侧 SQLite 状态是否仍然一致。

因此当前判断是：Cloudflare Containers outbound interception 是更接近产品化的方向，但完成标准应以实际 POC 证明 `SSE connected`、`worker registered`、事件写回和 result 落库，而不是仅凭 handler 配置存在。

### 本地验证结果

当前 Bun/Hono route 已使用真实 Claude Code CLI `2.1.120` 和官方 Anthropic API key 验证以下链路：

- 基础会话：route 下发 user event，worker 写回 system/user/assistant/result/internal events，最终 result 成功落库。
- route 侧 MCP 工具：route 先通过 `control_request.initialize` 注入 `sdkMcpServers: ["ccr-route"]`，Claude Code 随后通过 `mcp_message` 完成 `initialize`、`tools/list`、`tools/call`，route 在本进程执行 `ccr_echo` 并返回 `route-ok`。
- 用户问询：Claude Code 调用 `AskUserQuestion` 时会先发出 `can_use_tool`，route 自动 allow 时必须返回 `updatedInput`，否则 Claude Code `2.1.120` 会因权限 schema 校验失败而拒绝工具调用。
- subagent：Claude Code 调用 Task/Agent 后，route 能记录 `task_started`、`task_notification`、tool result，以及带 `agent_id` 的 subagent internal events。
- SSE 稳定性：真实 CLI 曾在 15 秒心跳下约 12 秒空闲断连；route 心跳调整为 5 秒后，复测日志未再出现 `Stream read error` 或 `socket connection was closed unexpectedly`。
- 业务 chat API：`POST /api/ccr/sessions/{sessionId}/messages` 在 `Accept: text/event-stream` 下会先返回 `session` SSE frame，再写入用户消息、启动真实远程模式 Claude Code CLI，并在同一个请求里持续输出 `timeline` frame；收到 `result` 后返回 `done` 并结束本次前端长连接。
- 会话详情 API：`GET /api/ccr/sessions/{sessionId}` 返回 `session`、`clientEvents`、`timeline` 和 `internal`。route 会分页拉全这些事件；前端用 `clientEvents` 恢复用户已发送消息，用 `timeline` 恢复 worker 可见事件，刷新页面后仍能重建完整对话流。
- Claude Code 的 `ANTHROPIC_BASE_URL` 应传 origin，例如 `https://ai-api.mandao.com`；CLI 会自行拼接 `/v1/messages`，如果传 `https://ai-api.mandao.com/v1` 会请求到 `/v1/v1/messages` 并表现为 `model_not_found`/404。本项目在写入 sandbox env 时会把末尾 `/v1` 规范化为 origin。
- `/worker/events` 写入 terminal `result` 后会停止当前 session runner，并将 session 状态收敛为 `workerStatus=idle`、`containerStatus=stopped`、`runnerProcessId=null`；这个保底逻辑在后端 worker transport 层执行，不依赖前端 SSE 是否仍然连接，避免旧进程继续写入 `keep_alive`。

远程模式的启动时序要求：

- A 服务不需要早于 B 容器长期启动；B 容器可以由 A 按需创建。
- 但 A 的 CCR routes 必须在 B runner 获取 worker credential/epoch 前可访问。
- 获取 `worker_epoch` 有两种路径：
  - env-less code session 路径：调用 `/v1/code/sessions/{sessionId}/bridge`，它本身会返回 worker JWT 和 `worker_epoch`，不需要再调 `/worker/register`。
  - env-based worker 路径：调用 `/v1/code/sessions/{sessionId}/worker/register`，再把返回的 `worker_epoch` 注入 B。
- Claude Code CLI 子进程必须在拿到 `worker_epoch` 后再启动，因为 CCR v2 初始化会读取 `CLAUDE_CODE_WORKER_EPOCH`。

env-based 注册 worker 请求：

```text
POST https://A/v1/code/sessions/{sessionId}/worker/register
Authorization: Bearer {workerJwt}
Content-Type: application/json

{}
```

返回中至少需要：

```json
{
  "worker_epoch": 1
}
```

`worker_epoch` 会传给 Claude Code 子进程。后续所有 worker 写请求都会带这个 epoch；服务端可以用它区分当前有效 worker 和被替换的旧 worker。

推荐时序：

```text
1. A session service 准备好 CCR routes。
2. A 创建 sessionId，并按需启动 B 容器。
3. B runner 启动后向 A 获取 worker credential/epoch:
   - env-less: POST /v1/code/sessions/{sessionId}/bridge
   - env-based: POST /v1/code/sessions/{sessionId}/worker/register
4. A 返回 worker_epoch。
5. B runner 设置 CLAUDE_CODE_WORKER_EPOCH，并启动 Claude Code CLI。
6. Claude Code CLI 连接 A:
   GET /worker/events/stream
   PUT /worker
   POST /worker/heartbeat
```

## worker_epoch 语义

`worker_epoch` 是同一个 session 下当前有效 worker 的代际编号。

```text
sessionId = 会话身份
worker_epoch = 当前执行者版本
```

它不是安全凭证，安全仍然依赖 `Authorization: Bearer {workerJwt}`。它的职责是并发和生命周期一致性控制：

- 防止旧 worker 继续写入。同一个 session 下如果旧 B 容器网络卡住，A 又启动了新 B 容器，两个 worker 可能短时间同时存在；服务端只应接受最新 epoch 的写入。
- 支持容器重启、抢占和恢复。新 worker 注册后拿到新的 epoch，旧 worker 再写 `/worker/events`、`/worker/internal-events`、`PUT /worker` 或 heartbeat 时应收到 `409`。
- 保证事件归属。所有 worker 写请求都带 `worker_epoch`，服务端用它判断事件是否来自当前有效 worker。
- 避免双写和乱序。没有 epoch 时，旧容器恢复网络后可能继续写 assistant events、internal events 或状态，导致 session 状态被污染。

最小实现建议：

```text
session.worker_epoch 初始为 0

POST /worker/register:
  session.worker_epoch += 1
  return { worker_epoch: session.worker_epoch }

所有 worker 写请求:
  if body.worker_epoch !== session.worker_epoch:
    return 409
  else:
    accept
```

## sdkUrl 生成规则

CCR v2 的 `sdkUrl` 是 HTTP(S) session base URL：

```text
https://A/v1/code/sessions/{sessionId}
```

Claude Code 子进程内部会派生实际读写端点：

```text
GET  https://A/v1/code/sessions/{sessionId}/worker/events/stream
POST https://A/v1/code/sessions/{sessionId}/worker/events
POST https://A/v1/code/sessions/{sessionId}/worker/internal-events
GET  https://A/v1/code/sessions/{sessionId}/worker/internal-events
POST https://A/v1/code/sessions/{sessionId}/worker/events/delivery
PUT  https://A/v1/code/sessions/{sessionId}/worker
GET  https://A/v1/code/sessions/{sessionId}/worker
POST https://A/v1/code/sessions/{sessionId}/worker/heartbeat
```

与 v1 session-ingress 对比：

```text
v1:
wss://A/v1/session_ingress/ws/{sessionId}

CCR v2:
https://A/v1/code/sessions/{sessionId}
```

v1 的 `sdkUrl` 本身是 WebSocket URL；CCR v2 的 `sdkUrl` 是 session base URL。

## CCR v2 route 与数据格式

本节分两层：

- Session 管理层：A 主服务面向 UI、用户消息、容器调度或 OAuth worker credential 的接口。
- Worker transport 层：B Claude Code CLI 通过 `--sdk-url` 直接访问的 `/worker/*` 接口。

如果本项目自己实现完整 CCR service，两层都需要考虑；如果只做 B worker transport POC，可以先实现 Worker transport 层。

## Session 管理层接口

### POST /v1/code/sessions

用途：创建 code session，返回 `cse_*` session id。源码中的 env-less remote bridge 会先调用这个接口，再调用 `/bridge` 获取 worker 凭证。

请求形态：

```json
{
  "title": "Session title",
  "bridge": {},
  "tags": ["optional-tag"]
}
```

响应形态：

```json
{
  "session": {
    "id": "cse_xxx"
  }
}
```

说明：

- `bridge: {}` 是 runner oneof 的正向信号；源码注释说明省略它或传空 `environment_id` 会导致服务端拒绝。
- 这个接口使用 OAuth 用户凭证，不是 worker JWT。

### POST /v1/code/sessions/{sessionId}/bridge

用途：用 OAuth 凭证换取 worker 可用的 JWT、API base URL 和 `worker_epoch`。

请求：

```json
{}
```

响应：

```json
{
  "worker_jwt": "opaque-worker-jwt",
  "api_base_url": "https://A",
  "expires_in": 3600,
  "worker_epoch": 1
}
```

说明：

- 在 env-less 路径中，`/bridge` 本身会 bump epoch，等价于注册 worker。
- 这种路径不需要再单独调用 `/worker/register`。
- `expires_in` 用于主动刷新 worker JWT；每次重新调用 `/bridge` 都会获得新的 epoch，旧 worker 会在后续请求中收到 `409`。
- 如果使用本项目自定义鉴权，也可以把这个接口简化为内部 credential minting，但语义应保留：颁发 worker token、返回 API base、返回 epoch。

### POST /v1/sessions/{sessionId}/events

用途：向 session 投递用户消息或其他 session 级事件。UI 或 A 主服务可以用它把用户输入写入 session，再由 worker SSE 流下发给 B。

请求形态：

```json
{
  "events": [
    {
      "uuid": "event-uuid",
      "session_id": "session_or_cse_id",
      "type": "user",
      "parent_tool_use_id": null,
      "message": {
        "role": "user",
        "content": "hello"
      }
    }
  ]
}
```

说明：

- 这是 compat Sessions API 入口，源码里用于向远端 session 发送用户消息。
- 对自建 A 服务来说，可以不暴露这个 exact route，但必须有等价的“用户消息入队 -> worker SSE 下发”能力。

### PATCH /v1/sessions/{sessionId}

用途：更新 session 标题等 metadata。

请求形态：

```json
{
  "title": "New title"
}
```

说明：

- 源码中 remote-control 会在用户重命名或自动推导标题时调用。
- 可作为 POC 的非核心接口，后续用于 UI 同步。

### POST /v1/sessions/{sessionId}/archive

用途：归档 session。

请求：

```json
{}
```

说明：

- 源码中 shutdown/teardown 会 best-effort 调用。
- `409` 被视为已经归档，具备幂等语义。
- 对自建 A 服务来说，它对应 session 关闭、停止展示或资源清理。

## Worker transport 层接口

### POST /worker/register

用途：注册当前 worker，获取 `worker_epoch`。

请求：

```json
{}
```

响应：

```json
{
  "worker_epoch": 1
}
```

### GET /worker/events/stream

用途：SSE 下发 client-to-worker 事件。

子进程通过这个流接收远端用户消息、控制事件、权限响应等。每个 SSE frame 的数据里至少需要包含服务端事件标识和 payload；B 侧收到后会通过 delivery endpoint 回报状态。worker stream 只下发 `queued` 状态的 client event；已回报 `received` 的事件不能在新 worker epoch 中再次下发，否则会导致历史用户输入被重复执行并写入可见时间线。会话详情接口仍读取全部 client event，用于恢复前端用户消息气泡。

概念形态：

```text
event: client_event
id: {eventId}
data: {"event_id":"...","sequence_num":1,"event_type":"...","source":"...","payload":{...}}
```

具体字段应以 B 侧 Claude Code `SSETransport` 可解析的格式为准。

### POST /worker/events

用途：worker 向前端/控制面写可见事件。

请求：

```json
{
  "worker_epoch": 1,
  "events": [
    {
      "payload": {
        "type": "assistant",
        "uuid": "event-uuid"
      }
    },
    {
      "payload": {
        "type": "stream_event",
        "uuid": "event-uuid",
        "session_id": "cse_xxx",
        "parent_tool_use_id": null,
        "event": {
          "type": "content_block_delta",
          "index": 0,
          "delta": {
            "type": "text_delta",
            "text": "partial text"
          }
        }
      },
      "ephemeral": true
    }
  ]
}
```

说明：

- `payload` 基本是 Claude Code stdout message 原始结构，并补 `uuid` 做幂等。
- `stream_event` 会被客户端按 100ms 窗口合并，text delta 会变成 full-so-far 快照。
- `ephemeral: true` 主要用于流式临时事件。
- `payload.type === "keep_alive"` 只用于维持 worker 长连接，不写入 `chat_worker_events`，也不进入 operation log。
- 同一 session、同一 worker epoch 的 `system/init` 只保留第一条，避免 runner 初始化元数据重复污染可见时间线。
- `payload.uuid` 是 visible event 的幂等键；重复上报同一 uuid 时不再写 `chat_worker_events`，也不再写 operation log，避免审计流和事件表语义不一致。

### POST /worker/internal-events

用途：写 worker 内部事件，不直接展示给前端，主要用于 transcript、compaction、resume。

请求：

```json
{
  "worker_epoch": 1,
  "events": [
    {
      "payload": {
        "type": "transcript_event_type",
        "uuid": "event-uuid"
      },
      "is_compaction": false,
      "agent_id": "optional-agent-id"
    }
  ]
}
```

### GET /worker/internal-events

用途：恢复 foreground agent 的 internal events。

`payload.type === "keep_alive"` 不写入 `chat_internal_events`，避免保活包污染可恢复事件历史。

响应：

```json
{
  "data": [
    {
      "event_id": "event-id",
      "event_type": "transcript_event_type",
      "payload": {},
      "event_metadata": null,
      "is_compaction": false,
      "created_at": "2026-05-19T00:00:00.000Z",
      "agent_id": "optional-agent-id"
    }
  ],
  "next_cursor": "optional-cursor"
}
```

子 agent 恢复会使用：

```text
GET /worker/internal-events?subagents=true
```

### POST /worker/events/delivery

用途：worker 对从 SSE 收到的事件上报 delivery 状态。

请求：

```json
{
  "worker_epoch": 1,
  "updates": [
    {
      "event_id": "server-event-id",
      "status": "received"
    },
    {
      "event_id": "server-event-id",
      "status": "processing"
    },
    {
      "event_id": "server-event-id",
      "status": "processed"
    }
  ]
}
```

状态枚举：

```text
received | processing | processed
```

说明：delivery update 只对已存在的 client event 生效；空 `event_id` 或找不到原始 client event 时会被忽略，避免写入孤儿 delivery 审计行。

### PUT /worker

用途：上报 worker 状态和外部 metadata。

初始化请求：

```json
{
  "worker_epoch": 1,
  "worker_status": "idle",
  "external_metadata": {
    "pending_action": null,
    "task_summary": null
  }
}
```

运行状态：

```json
{
  "worker_epoch": 1,
  "worker_status": "running"
}
```

等待外部动作：

```json
{
  "worker_epoch": 1,
  "worker_status": "requires_action",
  "requires_action_details": {
    "tool_name": "AExternalTool",
    "action_description": "Calling A-side tool",
    "request_id": "request-id",
    "tool_use_id": "tool-use-id"
  },
  "external_metadata": {
    "pending_action": {
      "tool_name": "AExternalTool",
      "action_description": "Calling A-side tool",
      "tool_use_id": "tool-use-id",
      "request_id": "request-id",
      "input": {}
    }
  }
}
```

`external_metadata` 使用类似 RFC 7396 的 merge patch 语义，字段为 `null` 表示服务端应删除或清空对应状态。

### GET /worker

用途：worker 初始化时恢复之前写入的 `external_metadata`。

响应：

```json
{
  "worker": {
    "external_metadata": {
      "permission_mode": "default",
      "model": "sonnet",
      "pending_action": null,
      "task_summary": null
    }
  }
}
```

### POST /worker/heartbeat

用途：worker 存活心跳。

请求：

```json
{
  "session_id": "cse_xxx",
  "worker_epoch": 1
}
```

默认心跳间隔约 20s，服务端可以用它管理 worker TTL。

## 接口完整性核对

本轮从 `claude-code-reverse` 中按 CCR/code-session/worker 关键路径复扫后，当前文档覆盖的接口如下：

### B worker 直接依赖

- `POST /v1/code/sessions/{sessionId}/worker/register`
- `GET /v1/code/sessions/{sessionId}/worker/events/stream`
- `POST /v1/code/sessions/{sessionId}/worker/events`
- `POST /v1/code/sessions/{sessionId}/worker/internal-events`
- `GET /v1/code/sessions/{sessionId}/worker/internal-events`
- `GET /v1/code/sessions/{sessionId}/worker/internal-events?subagents=true`
- `POST /v1/code/sessions/{sessionId}/worker/events/delivery`
- `PUT /v1/code/sessions/{sessionId}/worker`
- `GET /v1/code/sessions/{sessionId}/worker`
- `POST /v1/code/sessions/{sessionId}/worker/heartbeat`

### A/UI/session 管理可能依赖

- `POST /v1/code/sessions`
- `POST /v1/code/sessions/{sessionId}/bridge`
- `POST /v1/sessions/{sessionId}/events`
- `PATCH /v1/sessions/{sessionId}`
- `POST /v1/sessions/{sessionId}/archive`

### 不属于本项目 MVP 的旧环境层接口

旧 remote-control bridge 还有 Environments API：

- `POST /v1/environments/bridge`
- `GET /v1/environments/{environmentId}/work/poll`
- work ack/heartbeat/stop/reconnect
- `DELETE /v1/environments/bridge/{environmentId}`

这些属于 env-based work-dispatch 层。当前方案选择由 A 主服务直接调度 B 容器并实现 code session/worker transport，因此不把 Environments API 作为 MVP 必需接口。

## A/B 机器职责

### A 主服务

A 负责：

- 实现 CCR v2 session service。
- 管理 session、事件队列、worker epoch 和 delivery 状态。
- 在需要时启动 B 容器。
- 提供 A-side 外部工具执行能力。
- 把 A-side 工具结果通过受控事件回传给 B。
- 管理 sessionId、runtime、workspace volume、transcript 的映射。

A 不应该直接接管：

- `Read/Edit/Write/Bash/Grep` 等 Claude Code 内置工具。
- B workspace 的本地文件系统操作。
- B 本地 `.claude/skills`、`CLAUDE.md`、`.mcp.json` 的自动发现。

### B 执行容器

B 负责：

- 运行 Claude Code CLI。
- 挂载 workspace。
- 提供 `.claude/skills`、`CLAUDE.md`、`.mcp.json`、settings。
- 执行内置 tools。
- 通过 CCR v2 连接 A。

## Tools 边界

### 内置 tools

以下工具默认在 B 执行：

```text
Read / Write / Edit / MultiEdit
Bash
Glob / Grep / LS
NotebookEdit
LSP
TodoWrite
SkillTool
AgentTool / subagent
```

`--sdk-url` 不会把它们变成 A 上的 RPC。

### A-side 外部 tools

当前目标是：只让部分外部提供的工具在 A 运行，不伪造内置工具结果。

推荐约束：

- A-side tool 必须有独立工具名，例如 `AQueryDatabase`、`AInternalSearch`。
- B 侧必须能产生一个可等待的外部工具请求。
- A 侧必须用 `request_id` 关联请求和响应，不能只靠 tool name 或 tool_use_id。
- A 侧执行完成后，通过 CCR 下发 B 能识别的响应事件，让 B 继续当前 turn。
- 同步更新 worker 状态，避免 UI、resume 和内部 transcript 不一致。

待验证点：

- B 侧 `StructuredIO` 支持哪些 inbound control message 类型。
- 外部工具请求在 `/worker/events` 中的具体事件形态。
- A 回填结果时应使用 `control_response`、tool result message，还是专用外部工具响应。
- 回填后 `/worker/internal-events` 是否需要同步写入，避免 resume 丢失。

## 会话和进程模型

当前 remote-control 实现可以近似理解为：

```text
1 个 bridge worker
  -> N 个 active sessions
    -> N 个 claude --print --sdk-url 子进程
```

对本项目更适合的 POC 模型：

```text
A CCR service
  -> 按 session 启动 B 容器
    -> B 内 1 个 claude --print --sdk-url 子进程
```

容器是否一会话一个，取决于隔离策略：

- 最强隔离：一个会话一个容器。
- 更低冷启动：一个 workspace 一个 warm 容器，容器内限制同一时刻一个 Claude 进程。
- 不建议初期多进程共享同一个工作目录，容易发生文件覆盖和 git 状态冲突。

## 容器重建与 session resume 方案

目标场景：

- Claude Code 运行在 B 容器中。
- A 主服务在 CCR 连接建立后完整保存 session 事件。
- Claude Code 运行时仍会在 B 容器内写本地 jsonl transcript。
- B 容器可能重建，容器内 jsonl 可能丢失。
- 重建后希望通过 A 主服务保存的记录恢复 session。

结论：在 CCR v2 路线里，A 主服务应当把 `/worker/internal-events` 和 `/worker` 的 `external_metadata` 作为权威恢复源。B 容器内 jsonl 只能作为运行期本地副本，不能作为唯一恢复源。

### 恢复链路

```text
1. A 检测到 session 需要继续执行，按需创建新的 B 容器。
2. B runner 调用 A:
   POST /v1/code/sessions/{sessionId}/worker/register
3. A 递增并返回新的 worker_epoch。
4. B runner 设置 CLAUDE_CODE_WORKER_EPOCH，并启动 Claude Code CLI。
5. Claude Code CLI 连接 A 的 CCR routes。
6. Claude Code 通过 GET /worker 读取 external_metadata。
7. Claude Code 通过 GET /worker/internal-events 读取 foreground internal events。
8. 如果存在 subagent，Claude Code 通过 GET /worker/internal-events?subagents=true 读取子 agent internal events。
9. Claude Code 基于 A 返回的数据重建会话状态并继续处理后续事件。
```

### A 主服务的持久化义务

A 不能只保存 `/worker/events` 里的可见 assistant/result/stream events。可见 events 更适合 UI 展示；真正用于恢复的是 internal events 和 worker metadata。

A 至少要持久化：

- `/worker/internal-events` 写入的 transcript、compaction、agent 内部事件。
- `event_id`、`event_type`、`payload`、`event_metadata`、`is_compaction`、`agent_id`、`created_at` 和稳定顺序字段。
- `/worker` 写入的 `external_metadata`，例如 `pending_action`、`task_summary`、`permission_mode`、`model`。
- session 与 workspace volume/runtime 的映射。

建议最小数据结构：

```ts
type CcrInternalEvent = {
  sessionId: string
  eventId: string
  eventType: string
  payload: Record<string, unknown>
  eventMetadata: Record<string, unknown> | null
  isCompaction: boolean
  agentId: string | null
  createdAt: string
  sequence: number
}
```

读取响应形态：

```json
{
  "data": [
    {
      "event_id": "event-id",
      "event_type": "transcript_event_type",
      "payload": {},
      "event_metadata": null,
      "is_compaction": false,
      "created_at": "2026-05-19T00:00:00.000Z",
      "agent_id": null
    }
  ],
  "next_cursor": null
}
```

### internal-events 读取规则

- MVP 可以先按 `sessionId + sequence` 全量返回，优先保证正确性。
- 后续可以利用 `is_compaction` 优化，只返回最后一次 compaction 边界之后的事件。
- `GET /worker/internal-events` 返回 foreground agent 事件。
- `GET /worker/internal-events?subagents=true` 返回非 foreground agents 的事件，并保留 `agent_id`。
- `worker_epoch` 重建时会变化，但 internal events 属于 `sessionId`，不属于某个 epoch。
- 旧 worker 的 epoch 不匹配时必须返回 `409`，避免旧容器继续写入污染恢复源。

### workspace 约束

CCR internal events 能恢复对话和 worker 内部状态，但不能恢复容器临时盘里的文件状态。

因此 workspace 必须独立持久化：

- 使用 PVC、NFS、持久盘或对象存储同步层。
- 或由 A 在容器启动时重新 materialize workspace。
- 如果 workspace 丢失，即使 session 事件恢复成功，模型看到的上下文也会和实际文件状态不一致。

### 与 sessionStore 的关系

`sessionStore` 是 Agent SDK 路线的 transcript 外部存储适配器，适合：

```text
A Agent SDK query()
  -> spawnClaudeCodeProcess 远程启动 B
  -> sessionStore mirror transcript 到外部存储
```

当前项目选择的是：

```text
A 实现 CCR v2 session service
B claude --print --sdk-url A
```

因此最小闭环优先实现 CCR v2 的 `/worker/internal-events` 和 `/worker` metadata，不必先接 `sessionStore`。两套机制可以后续做同步或备份，但不应在 MVP 中同时作为权威恢复源，否则会引入去重、顺序和恢复来源冲突。

## MVP 建议

### v1 协议骨架

- 实现 `/worker/register`。
- 实现 `/worker/events/stream` SSE。
- 实现 `/worker/events` 收集 worker 输出。
- 实现 `/worker/heartbeat` 和 `/worker` 状态上报。
- 固定单 session、单 worker、单进程。

### v2 internal events 与 resume

- 实现 `/worker/internal-events` 写入和分页读取。
- 保存 transcript、compaction、agent_id。
- 验证容器销毁后重新启动能恢复 session。

### v3 A-side 外部工具

- 定义一个 A-side mock tool。
- 让 B 产生可等待的外部工具请求。
- A 记录 request registry。
- A 执行工具并通过 CCR stream 回填。
- 验证 B 能继续当前 turn，且状态和 internal events 一致。

## 风险

- CCR v2 worker 协议不是公开稳定 API，schema 可能变化。
- 只实现 happy path 很容易跑通 demo，但 resume、delivery、epoch 替换和重复事件会影响稳定性。
- A-side tool 回填必须严格处理 `request_id`、顺序和幂等。
- 如果 B 上配置缺失，Claude Code 会读不到 skills、MCP 或项目 memory；A 的本地配置不会自动生效。
- 冷启动容器会影响首 token 延迟，需要后续考虑镜像预热、warm pool 或 workspace 缓存。

## 源码参考

来自 `claude-code-reverse` 的关键文件：

- `src/bridge/workSecret.ts`：`sdkUrl` 生成、worker register。
- `src/bridge/bridgeMain.ts`：remote-control session spawn 和 CCR v2 分支。
- `src/bridge/sessionRunner.ts`：子 Claude Code CLI 启动参数和环境变量。
- `src/cli/remoteIO.ts`：`--sdk-url` 进入 RemoteIO。
- `src/cli/transports/transportUtils.ts`：CCR v2 使用 SSE + POST。
- `src/cli/transports/ccrClient.ts`：worker events、internal-events、delivery、heartbeat、worker state。
- `src/cli/transports/SSETransport.ts`：SSE stream 解析。
- `src/utils/sessionState.ts`：`idle/running/requires_action` 和 `external_metadata`。
