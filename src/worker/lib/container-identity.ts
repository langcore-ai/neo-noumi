/** 用户级 container ID 前缀；必须保持稳定以兼容已有 session、token 和观测数据。 */
const USER_CONTAINER_ID_PREFIX = "neo-noumi-user";

/**
 * 生成当前用户级容器 ID。
 * @param userId 登录用户 ID
 * @returns 用户级 container ID
 */
export function buildUserContainerId(userId: string): string {
	return `${USER_CONTAINER_ID_PREFIX}-${userId}`;
}
