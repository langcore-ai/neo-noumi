/** Worker 写入的可见 timeline 事件。 */
export interface TimelineEvent {
	id: number;
	event_id: string;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: string;
	ephemeral: boolean;
}

/** 用户发送后写入的 client event。 */
export interface ClientEvent {
	event_id: string;
	sequence_num: number;
	event_type: string;
	source: string;
	payload: Record<string, unknown>;
	created_at: string;
}

/** 页面消息模型，用于把用户消息和 worker timeline 统一渲染。 */
export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	createdAt: string;
	status?: "pending" | "streaming" | "done" | "error";
	meta?: string;
	payloadDataType?: string;
	chunk: ClientEvent | TimelineEvent;
	raw?: unknown;
}

/** payload.data.type 专用气泡组件属性。 */
export interface PayloadDataBubbleRendererProps {
	/** 页面消息模型。 */
	message: ChatMessage;
	/** 完整 timeline 消息 chunk，用于专用渲染器读取上下文。 */
	chunk: TimelineEvent;
	/** payload.data.type 业务类型。 */
	payloadDataType: string;
}

/** Claude Code 工具权限申请。 */
export interface ToolPermissionRequest {
	/** control request ID。 */
	requestId: string;
	/** Claude Code 申请调用的工具名。 */
	toolName: string;
	/** Claude Code tool_use ID。 */
	toolUseId: string;
	/** 工具入参。 */
	input: Record<string, unknown>;
	/** 对应 timeline 事件 ID。 */
	eventId: number;
	/** 申请创建时间。 */
	createdAt: string;
}

/**
 * 判断值是否是普通对象。
 * @param value 待判断值
 * @returns 是否是对象
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 从 timeline 事件中提取工具权限申请。
 * @param event timeline 事件
 * @returns 工具权限申请；非 can_use_tool 时返回 null
 */
function readToolPermissionRequest(event: TimelineEvent): ToolPermissionRequest | null {
	const payload = isRecord(event.payload) ? event.payload : null;
	const request = isRecord(payload?.request) ? payload.request : null;
	if (
		payload?.type !== "control_request" ||
		request?.subtype !== "can_use_tool" ||
		typeof payload.request_id !== "string"
	) {
		return null;
	}
	return {
		requestId: payload.request_id,
		toolName: typeof request.tool_name === "string" ? request.tool_name : "unknown",
		toolUseId: typeof request.tool_use_id === "string" ? request.tool_use_id : "",
		input: isRecord(request.input) ? request.input : {},
		eventId: event.id,
		createdAt: event.created_at,
	};
}

/**
 * 判断指定权限申请是否已经有用户响应。
 * @param clientEvents client events
 * @param requestId control request ID
 * @returns 是否已经响应
 */
function hasToolPermissionResponse(
	clientEvents: ClientEvent[],
	requestId: string,
): boolean {
	return clientEvents.some((event) => {
		const payload = isRecord(event.payload) ? event.payload : null;
		const response = isRecord(payload?.response) ? payload.response : null;
		return (
			payload?.type === "control_response" &&
			typeof response?.request_id === "string" &&
			response.request_id === requestId
		);
	});
}

/**
 * 查找当前仍待用户决策的工具权限申请。
 * @param timeline worker timeline
 * @param clientEvents client events
 * @param handledRequestIds 当前页面已提交的 request ID
 * @returns 最新的待处理权限申请
 */
export function findPendingToolPermissionRequest(
	timeline: TimelineEvent[],
	clientEvents: ClientEvent[],
	handledRequestIds: Set<string>,
): ToolPermissionRequest | null {
	const requests = timeline
		.map(readToolPermissionRequest)
		.filter((request): request is ToolPermissionRequest => Boolean(request))
		.sort((a, b) => b.eventId - a.eventId);
	return (
		requests.find((request) => {
			return (
				!handledRequestIds.has(request.requestId) &&
				!hasToolPermissionResponse(clientEvents, request.requestId)
			);
		}) ?? null
	);
}

/**
 * 把未知内容转成适合消息气泡展示的文本。
 * @param value 原始内容
 * @returns 展示文本
 */
function stringifyContent(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				if (typeof item === "string") {
					return item;
				}
				if (isRecord(item) && typeof item.text === "string") {
					return item.text;
				}
				return JSON.stringify(item, null, 2);
			})
			.join("\n");
	}
	if (value === undefined || value === null) {
		return "";
	}
	return JSON.stringify(value, null, 2);
}

/**
 * 读取 assistant content block 的内部类型。
 * @param payload worker payload
 * @returns content block 类型；没有时返回 null
 */
function getAssistantContentType(payload: Record<string, unknown>): string | null {
	const message = isRecord(payload.message) ? payload.message : null;
	const content = Array.isArray(message?.content) ? message.content : [];
	const block = content.find((item) => {
		return isRecord(item) && typeof item.type === "string";
	});
	return isRecord(block) && typeof block.type === "string" ? block.type : null;
}

/**
 * 读取 payload.data.type 业务类型。
 * @param payload worker payload
 * @returns payload data 类型；没有时返回 null
 */
function getPayloadDataType(payload: Record<string, unknown>): string | null {
	const data = isRecord(payload.data) ? payload.data : null;
	return typeof data?.type === "string" ? data.type : null;
}

/**
 * 计算 timeline 的展示语义类型。
 * @param event timeline event
 * @returns 用于 UI 归类和折叠的类型
 */
function getTimelineDisplayType(event: TimelineEvent): string {
	const contentType = getAssistantContentType(event.payload);
	// Claude Code 会把 thinking/tool_use 包在 assistant message 里，UI 应按内层 block 类型展示。
	if (contentType === "thinking" || contentType === "tool_use") {
		return contentType;
	}
	// progress frame 的细分类型放在 data.type，气泡折叠规则需要使用这个业务类型。
	const payloadDataType = getPayloadDataType(event.payload);
	if (payloadDataType) {
		return payloadDataType;
	}
	return event.event_type;
}

/**
 * 从 Claude Code payload 中提取面向用户的文本。
 * @param payload worker payload
 * @returns 消息文本
 */
function extractWorkerText(payload: Record<string, unknown>): string {
	const message = isRecord(payload.message) ? payload.message : null;
	if (message) {
		const contentBlocks = Array.isArray(message.content) ? message.content : [];
		const thinking = contentBlocks
			.map((item) => {
				return isRecord(item) && typeof item.thinking === "string"
					? item.thinking
					: "";
			})
			.filter(Boolean)
			.join("\n");
		if (thinking) {
			return thinking;
		}
		const content = stringifyContent(message.content);
		if (content) {
			return content;
		}
	}
	if (typeof payload.text === "string") {
		return payload.text;
	}
	if (typeof payload.content === "string") {
		return payload.content;
	}
	if (typeof payload.thinking === "string") {
		return payload.thinking;
	}
	if (typeof payload.result === "string") {
		return payload.result;
	}
	if (typeof payload.summary === "string") {
		return payload.summary;
	}
	return JSON.stringify(payload, null, 2);
}

/**
 * 从 client event 提取用户消息。
 * @param event client event
 * @returns 页面消息
 */
function clientEventToMessage(event: ClientEvent): ChatMessage | null {
	const message = isRecord(event.payload.message) ? event.payload.message : null;
	if (!message) {
		return null;
	}
	return {
		id: `client-${event.event_id}`,
		role: "user",
		content: stringifyContent(message.content),
		createdAt: event.created_at,
		status: "done",
		chunk: event,
	};
}

/**
 * 判断 timeline 是否属于辅助运行事件。
 * @param event timeline event
 * @returns 是否是辅助事件
 */
function isSupportTimelineEvent(event: TimelineEvent): boolean {
	return [
		"system",
		"control_request",
		"control_response",
		"tool_use",
		"tool_result",
		"thinking",
		"bash_progress",
		"result",
		"unknown",
	].includes(event.event_type);
}

/**
 * 从 worker timeline 提取可读消息。
 * @param event timeline event
 * @returns 页面消息
 */
function timelineEventToMessage(event: TimelineEvent): ChatMessage {
	const displayType = getTimelineDisplayType(event);
	const payloadDataType = getPayloadDataType(event.payload) ?? undefined;
	const isAssistant = displayType === "assistant";
	const isResult = event.event_type === "result" || event.payload.type === "result";
	return {
		id: `timeline-${event.id}`,
		role: isAssistant
			? "assistant"
			: isSupportTimelineEvent({ ...event, event_type: displayType })
				? "tool"
				: "system",
		content: extractWorkerText(event.payload),
		createdAt: event.created_at,
		status: isResult ? "done" : event.ephemeral ? "streaming" : "done",
		meta: displayType,
		payloadDataType,
		chunk: event,
		raw: event.payload,
	};
}

/**
 * 生成控制事件的折叠摘要。
 * @param raw 原始 timeline payload
 * @param meta 控制事件类型
 * @returns 控制事件摘要
 */
export function getControlEventSummary(
	raw: unknown,
	meta: string | undefined,
): string {
	if (!isRecord(raw)) {
		return meta === "control_response" ? "控制响应" : "控制请求";
	}
	if (meta === "control_response") {
		const response = isRecord(raw.response) ? raw.response : null;
		const subtype = typeof response?.subtype === "string" ? response.subtype : "unknown";
		const requestId =
			typeof response?.request_id === "string" ? ` · ${response.request_id}` : "";
		return `控制响应：${subtype}${requestId}`;
	}
	const request = isRecord(raw.request) ? raw.request : null;
	const subtype = typeof request?.subtype === "string" ? request.subtype : "unknown";
	const requestId = typeof raw.request_id === "string" ? ` · ${raw.request_id}` : "";
	return `控制请求：${subtype}${requestId}`;
}

/**
 * 生成工具调用的折叠摘要。
 * @param raw 原始 timeline payload
 * @returns 工具调用摘要
 */
export function getToolUseSummary(raw: unknown): string {
	if (!isRecord(raw)) {
		return "工具调用";
	}
	const message = isRecord(raw.message) ? raw.message : null;
	const content = Array.isArray(message?.content) ? message.content : [];
	const toolUse = content.find((item) => {
		return isRecord(item) && item.type === "tool_use";
	});
	const name =
		typeof raw.name === "string"
			? raw.name
			: isRecord(toolUse) && typeof toolUse.name === "string"
				? toolUse.name
				: "";
	return name ? `工具调用：${name}` : "工具调用";
}

/**
 * 判断消息 chunk 是否来自 timeline。
 * @param chunk 页面消息 chunk
 * @returns 是否为完整 timeline chunk
 */
export function isTimelineMessageChunk(
	chunk: ChatMessage["chunk"],
): chunk is TimelineEvent {
	return "id" in chunk && typeof chunk.id === "number" && "payload" in chunk;
}

/**
 * 合并并排序历史消息。
 * @param clientEvents 用户事件
 * @param timeline worker timeline
 * @returns 页面消息列表
 */
export function buildMessages(
	clientEvents: ClientEvent[],
	timeline: TimelineEvent[],
): ChatMessage[] {
	const userMessages = clientEvents.flatMap((event) => {
		const message = clientEventToMessage(event);
		return message ? [message] : [];
	});
	// 用户消息由 client events 恢复，timeline 中的 user 回显不再重复展示。
	const workerMessages = timeline
		.filter((event) => event.event_type !== "user")
		.map(timelineEventToMessage);
	return [...userMessages, ...workerMessages].sort((a, b) => {
		return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
	});
}

/**
 * 格式化消息气泡时间。
 * @param value ISO 时间
 * @returns 精确到毫秒的本地时间文本
 */
export function formatTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	const baseTime = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	// Intl 当前没有稳定的毫秒展示选项，手动补齐三位毫秒。
	const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
	return `${baseTime}.${milliseconds}`;
}
