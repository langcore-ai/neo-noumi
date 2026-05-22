/** 可持久化 JSON 基础值 */
export type JsonPrimitive = string | number | boolean | null;

/** 可持久化 JSON 值 */
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

/** 可持久化 JSON 对象 */
export type JsonObject = { [key: string]: JsonValue };

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
