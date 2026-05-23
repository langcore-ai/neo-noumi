import { isJsonObject } from "./ccr-json";
import type { JsonObject } from "./ccr-types";

/** Claude Code 允许用于 CCR `--sdk-url` 的专用 host，避免拦截真实 Anthropic API 推理请求。 */
export const CCR_SDK_APPROVED_HOST = "beacon.claude-ai.staging.ant.dev";

/** Client event 等待 worker 消费的状态。 */
export const CLIENT_EVENT_STATUS_QUEUED = "queued";

/** Client event 已被 worker 收到。 */
export const CLIENT_EVENT_STATUS_RECEIVED = "received";

/** Client event 对应命令已开始处理。 */
export const CLIENT_EVENT_STATUS_PROCESSING = "processing";

/** Client event 对应命令已处理完成。 */
export const CLIENT_EVENT_STATUS_PROCESSED = "processed";

/** Client event 入库后 runner 启动失败，不应再下发给 worker。 */
export const CLIENT_EVENT_STATUS_FAILED = "failed";

/** Client event 状态值。 */
export type ClientEventStatus =
	| typeof CLIENT_EVENT_STATUS_QUEUED
	| typeof CLIENT_EVENT_STATUS_RECEIVED
	| typeof CLIENT_EVENT_STATUS_PROCESSING
	| typeof CLIENT_EVENT_STATUS_PROCESSED
	| typeof CLIENT_EVENT_STATUS_FAILED;

/** worker delivery 可上报的状态。 */
export type DeliveryStatus =
	| typeof CLIENT_EVENT_STATUS_RECEIVED
	| typeof CLIENT_EVENT_STATUS_PROCESSING
	| typeof CLIENT_EVENT_STATUS_PROCESSED;

/** 状态推进顺序；failed 是本地终态，不能被 worker 后续 ack 覆盖。 */
const CLIENT_EVENT_STATUS_RANK: Record<ClientEventStatus, number> = {
	[CLIENT_EVENT_STATUS_QUEUED]: 0,
	[CLIENT_EVENT_STATUS_RECEIVED]: 1,
	[CLIENT_EVENT_STATUS_PROCESSING]: 2,
	[CLIENT_EVENT_STATUS_PROCESSED]: 3,
	[CLIENT_EVENT_STATUS_FAILED]: 4,
};

/** worker delivery 允许写入的状态集合。 */
const DELIVERY_STATUSES = new Set<string>([
	CLIENT_EVENT_STATUS_RECEIVED,
	CLIENT_EVENT_STATUS_PROCESSING,
	CLIENT_EVENT_STATUS_PROCESSED,
]);

/**
 * 读取 worker_epoch。
 * @param body 请求 JSON
 * @returns epoch；非法值返回 NaN
 */
export function readWorkerEpoch(body: JsonObject): number {
	const rawEpoch = body.worker_epoch;
	const epoch =
		typeof rawEpoch === "number"
			? rawEpoch
			: typeof rawEpoch === "string" && rawEpoch.trim() !== ""
				? Number(rawEpoch)
				: NaN;

	// worker_epoch 初始值 0 只存在于未注册 session；worker 写入必须来自已注册 runner。
	return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : NaN;
}

/**
 * 判断事件 payload 是否只是连接保活。
 * @param payload 事件 payload
 * @returns 是否应跳过业务持久化
 */
export function isKeepAlivePayload(payload: JsonObject): boolean {
	return payload.type === "keep_alive";
}

/**
 * 判断事件是否为 runner 初始化元数据。
 * @param payload 事件 payload
 * @returns 是否为 system/init 事件
 */
export function isSystemInitPayload(payload: JsonObject): boolean {
	return payload.type === "system" && payload.subtype === "init";
}

/**
 * 判断 worker visible event 是否表示本轮对话结束。
 * @param payload worker payload
 * @returns 是否结束
 */
export function isTerminalWorkerPayload(payload: JsonObject): boolean {
	return payload.type === "result";
}

/**
 * 从 payload 提取幂等 ID。
 * @param payload 事件 payload
 * @param createId 缺省 ID 生成器
 * @returns 事件 ID
 */
export function eventIdFromPayload(
	payload: JsonObject,
	createId: () => string = () => crypto.randomUUID(),
): string {
	return typeof payload.uuid === "string" ? payload.uuid : createId();
}

/**
 * 规范化 Claude Code 使用的 Anthropic base URL。
 * @param value 原始 base URL
 * @returns Claude Code 可接受的 origin；非法或空值保持原样
 */
export function normalizeClaudeBaseUrl(value: string | undefined): string | undefined {
	if (!value) {
		return value;
	}
	try {
		const url = new URL(value);
		// Claude Code 会自行拼接 /v1/messages，传入 /v1 会导致 /v1/v1/messages。
		return url.pathname === "/v1" || url.pathname === "/v1/"
			? url.origin
			: value.replace(/\/+$/, "");
	} catch {
		return value;
	}
}

/**
 * 收敛 worker delivery 状态。
 * @param value 原始状态
 * @returns 合法 delivery 状态；非法值返回 null
 */
export function normalizeDeliveryStatus(value: string): DeliveryStatus | null {
	return DELIVERY_STATUSES.has(value) ? (value as DeliveryStatus) : null;
}

/**
 * 根据当前状态和 worker 上报状态计算下一状态，避免乱序 ack 回退。
 * @param current 当前 client event 状态
 * @param incoming worker 上报状态
 * @returns 应写入的新状态；非法上报返回 null
 */
export function mergeClientEventDeliveryStatus(
	current: string,
	incoming: string,
): ClientEventStatus | null {
	const normalized = normalizeDeliveryStatus(incoming);
	if (!normalized) {
		return null;
	}
	const currentRank =
		CLIENT_EVENT_STATUS_RANK[current as ClientEventStatus] ??
		CLIENT_EVENT_STATUS_RANK[CLIENT_EVENT_STATUS_QUEUED];
	const incomingRank = CLIENT_EVENT_STATUS_RANK[normalized];
	// 已经进入更高状态时保持原状态，防止 received 覆盖 processed/failed。
	return incomingRank > currentRank ? normalized : (current as ClientEventStatus);
}

/**
 * 将未知 payload 收敛为 JSON 对象。
 * @param payload 原始 payload
 * @returns JSON 对象
 */
export function asCcrPayload(payload: unknown): JsonObject {
	return isJsonObject(payload) ? payload : {};
}
