import type { Context, Hono } from "hono";
import { createAuth, type AuthBindings } from "./auth";
import {
	getUserContainerSandbox,
	type UserContainerSandboxBindings,
} from "./container-sandbox";
import { readTerminalSessionId } from "./container-terminal";

/** 容器管理 route 需要的 Worker 绑定。 */
export type ContainerRouteBindings = AuthBindings & UserContainerSandboxBindings;

/** 容器管理 route 上下文变量。 */
type ContainerRouteVariables = {
	/** 当前登录用户 ID。 */
	userId: string;
};

/**
 * 校验登录用户并写入 route 变量。
 * @param c Hono context
 * @param next 后续中间件
 */
async function authenticateContainerUser(
	c: Context<{
		Bindings: Env & ContainerRouteBindings;
		Variables: ContainerRouteVariables;
	}>,
	next: () => Promise<void>,
) {
	const session = await createAuth(c.env).api.getSession({
		headers: c.req.raw.headers,
		query: { disableRefresh: true },
	});
	const userId = session?.user.id;
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	c.set("userId", userId);
	await next();
}

/**
 * 处理浏览器终端 WebSocket 代理请求。
 * @param c Hono context
 * @returns Sandbox PTY WebSocket response
 */
async function handleContainerTerminal(
	c: Context<{
		Bindings: Env & ContainerRouteBindings;
		Variables: ContainerRouteVariables;
	}>,
) {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		return c.json({ error: "WebSocket upgrade required" }, 426);
	}

	let sessionId: string;
	try {
		sessionId = readTerminalSessionId(c.req.query("sessionId"));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Invalid terminal sessionId" },
			400,
		);
	}

	const sandbox = getUserContainerSandbox(c.env.NEO_NOUMI_SANDBOX, c.get("userId"));
	const session = await sandbox.getSession(sessionId);
	// terminal() 只在 WebSocket 建立时触达容器，页面静态打开不会唤醒 sandbox。
	return session.terminal(c.req.raw);
}

/**
 * 挂载容器管理相关 route。
 * @param app Hono app
 */
export function mountContainerRoutes(
	app: Hono<{
		Bindings: Env & ContainerRouteBindings;
		Variables: ContainerRouteVariables;
	}>,
) {
	app.use("/api/container/*", authenticateContainerUser);
	app.get("/api/container/terminal", handleContainerTerminal);
}
