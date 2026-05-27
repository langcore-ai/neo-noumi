import type { JsonObject, JsonValue } from "./json";

export type { JsonObject, JsonPrimitive, JsonValue } from "./json";

/** CCR worker 状态值 */
export type WorkerStatus = "idle" | "running" | "requires_action";

/** Worker 可见事件 */
export interface WorkerVisibleEvent {
	/** Claude Code stdout message 原始结构 */
	payload: JsonObject;
	/** 是否为临时流式事件 */
	ephemeral?: boolean;
}

/** Worker 内部事件 */
export interface WorkerInternalEvent {
	/** transcript / compaction / resume 等内部 payload */
	payload: JsonObject;
	/** 是否是 compaction 边界 */
	is_compaction?: boolean;
	/** 子 agent 标识 */
	agent_id?: string;
	/** 附加事件元数据 */
	event_metadata?: JsonObject | null;
}

/** Chat 请求消息 */
export interface ChatMessageInput {
	/** 消息角色 */
	role: string;
	/** 消息内容 */
	content: JsonValue;
}
