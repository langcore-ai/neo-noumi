/**
 * 从 API 响应中读取错误消息。
 * @param response fetch 响应
 * @returns 错误消息
 */
export async function readError(response: Response): Promise<string> {
	const body = await response.json().catch(() => ({}));
	return typeof body.error === "string" ? body.error : response.statusText;
}
