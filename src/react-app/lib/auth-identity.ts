const INTERNAL_EMAIL_DOMAIN = "users.neo-noumi.local";

/**
 * 将用户名转换为 Better Auth 所需的内部邮箱。
 * @param username 用户名
 * @returns 内部邮箱地址
 */
export function createInternalEmail(username: string): string {
	// better-auth 的 email/password 流程要求 email，这里用用户名派生内部邮箱
	return `${username.trim().toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`;
}

/**
 * 清理用户输入的用户名。
 * @param username 用户名输入
 * @returns 去除首尾空白后的用户名
 */
export function normalizeUsernameInput(username: string): string {
	return username.trim();
}
