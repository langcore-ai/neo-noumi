import type { JsonObject, JsonValue } from "./ccr-types";

/**
 * 判断输入是否是普通 JSON 对象。
 * @param value 待判断值
 * @returns 是否为对象
 */
export function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从对象中读取字符串字段。
 * @param value JSON 对象
 * @param key 字段名
 * @returns 字符串字段值
 */
export function getStringField(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

/**
 * 将任意输入收敛为 JSON 值。
 * @param value 原始输入
 * @returns 可持久化 JSON 值
 */
export function toJsonValue(value: unknown): JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(toJsonValue);
	}
	if (isJsonObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
		);
	}
	return "";
}

/**
 * 安全读取请求 JSON 对象。
 * @param request 请求对象
 * @returns JSON 对象
 */
export async function readJsonObject(request: Request): Promise<JsonObject> {
	const parsed = await request.json().catch(() => ({}));
	return isJsonObject(parsed) ? parsed : {};
}

/**
 * 单层合并 JSON 对象。
 * @param base 基础对象
 * @param patch 补丁对象
 * @returns 合并结果
 */
export function mergeJsonObject(base: JsonObject, patch?: JsonObject): JsonObject {
	return patch ? { ...base, ...patch } : base;
}
