# Worker Lib 模块边界

## 模块责任

- `src/worker/lib` 同时包含 Worker 基础能力、通用业务基础设施和 CCR 业务层。
- 当前架构方向是“通用能力 + CCR 业务层”：通用模块沉淀可复用能力，CCR 模块只表达 Claude CCR 会话、协议、runner、工具和状态流转规则。
- 依赖方向必须保持为 `ccr-*` 调用通用模块；通用模块不能为了复用而反向 import `ccr-*`。

## 模块结构

- 通用容器能力：
  - `container-identity.ts` 负责用户级 container ID 规则。
  - `container-sandbox.ts` 负责根据用户 ID 获取容器对象、用户级容器销毁等容器基础操作。
  - `container-terminal.ts` 只负责终端 session ID 默认值和校验。
  - `container-routes.ts` 是通用容器管理 API 入口，不能依赖 `ccr-sandbox.ts`。
- 通用 JSON 和请求能力：
  - `json.ts` 负责 JSON 类型、对象判断、字段读取、请求 JSON 读取和 JSON merge patch。
  - 非 CCR 模块需要 JSON 工具时应直接引用 `json.ts`，不要新增 `ccr-*` 命名的通用工具。
- 通用 project workspace 能力：
  - `project-workspace.ts` 负责 R2 workspace 读写、签名 URL、路径校验和树操作。
  - `project-workspace-mount.ts` 负责 project workspace 在容器内的挂载路径、R2 prefix 和挂载开关规则。
- CCR 业务层：
  - `ccr-routes.ts` 是 CCR HTTP/SSE API 入口。
  - `ccr-sandbox.ts` 编排 CCR runner 生命周期、workspace 挂载、Claude 本地状态恢复和 sandbox outbound interception。
  - `ccr-store.ts` 负责 CCR session、worker lifecycle、operation log、AI proxy token 和 sessionStore 持久化。
  - `ccr-protocol.ts`、`ccr-control.ts`、`ccr-route-tools.ts`、`ccr-workspace-tools.ts` 只表达 CCR/Claude Code 协议和工具语义。
  - `ccr-claude-state.ts` 只放 Claude Code 本地状态路径规则。

## 依赖规则

- 允许：`ccr-*` import `container-*`、`json.ts`、`project-workspace*.ts`、`kv-cache.ts`、`prisma.ts`、`auth.ts`。
- 禁止：`container-*`、`json.ts`、`project-workspace*.ts`、`session-detail.ts` import `ccr-*`。
- 禁止：为了给通用代码复用，把容器 ID、Sandbox client、JSON 工具、workspace 挂载路径等基础能力放进 `ccr-*` 文件。
- 如果去掉 CCR 后仍然能复用，应放在通用模块；如果名字里必须出现 CCR 才说得清，应放在 `ccr-*` 模块。
- 业务状态清理由业务层负责。通用容器工具可以执行 `destroy()` 等基础操作，但不能直接更新 CCR session、runner 或数据库状态。

## 常见改动入口

- 新增容器控制台或容器基础操作：先看 `container-identity.ts`、`container-sandbox.ts`、`container-terminal.ts`，不要从 `ccr-sandbox.ts` 反向借函数。
- 新增 CCR runner 行为：改 `ccr-sandbox.ts`，只把容器固有操作下沉到 `container-*`。
- 新增 CCR 协议字段或控制事件：改 `ccr-protocol.ts` / `ccr-control.ts`，不要污染 `json.ts`。
- 新增 workspace 文件能力：先判断是 R2 workspace 通用能力还是 Claude/CCR 工具语义；前者放 `project-workspace*.ts`，后者放 `ccr-workspace-tools.ts`。

## 自检清单

- 新增的通用模块是否没有 import `ccr-*`。
- 新增的 `ccr-*` 代码是否只组合通用能力和 CCR 业务规则。
- 是否存在重复拼接 `{namespace}-{userId}`；应统一调用 `buildUserContainerId()`。
- 是否把 JSON、路径、容器等基础工具错误放进了 CCR 命名文件。
- 删除或移动模块后，使用 `rg "旧模块名|from \"./ccr"` 检查残留反向依赖。
