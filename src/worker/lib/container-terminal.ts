/** 容器控制台默认使用的 Sandbox session ID。 */
export const DEFAULT_CONTAINER_TERMINAL_SESSION_ID = "neo-noumi-console";

/** Sandbox session ID 允许的字符范围，避免把路径或控制字符传进容器端 PTY。 */
const TERMINAL_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * 生成当前用户级容器的 Sandbox ID。
 * @param userId 登录用户 ID
 * @returns 与现有用户级容器一致的 sandbox ID
 */
export function buildUserContainerSandboxId(userId: string): string {
	return `neo-noumi-user-${userId}`;
}

/**
 * 读取并校验终端 session ID。
 * @param value URL query 中的 sessionId
 * @returns 可交给 Sandbox SDK 使用的 session ID
 */
export function readTerminalSessionId(value: string | undefined): string {
	const sessionId = value || DEFAULT_CONTAINER_TERMINAL_SESSION_ID;
	if (!TERMINAL_SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error("Invalid terminal sessionId");
	}
	return sessionId;
}
