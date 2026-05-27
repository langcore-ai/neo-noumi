/** 用户级 sandbox ID 前缀，用于按用户复用同一个容器。 */
export const USER_CONTAINER_SANDBOX_ID_PREFIX = "noumi";

/**
 * 生成当前用户级容器 ID。
 * @param userId 登录用户 ID
 * @returns 用户级 container ID
 */
export function buildUserContainerId(userId: string): string {
	return `${USER_CONTAINER_SANDBOX_ID_PREFIX}-${userId}`;
}
