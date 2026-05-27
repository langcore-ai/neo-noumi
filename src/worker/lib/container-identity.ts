/** 用户级 sandbox ID 前缀，用于按用户复用同一个容器。 */
const USER_CONTAINER_SANDBOX_ID_PREFIX = "neo-noumi-user";

/**
 * 生成当前用户级容器的 Sandbox ID。
 * @param userId 登录用户 ID
 * @returns 用户级 sandbox ID
 */
export function buildUserContainerSandboxId(userId: string): string {
	return `${USER_CONTAINER_SANDBOX_ID_PREFIX}-${userId}`;
}
