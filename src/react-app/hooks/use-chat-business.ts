import { useMemo, useRef, useState } from "react";
import {
	buildMessages,
	type ClientEvent,
	findPendingToolPermissionRequest,
	type TimelineEvent,
	type ToolPermissionRequest,
} from "@/lib/chat-message-model";
import { readError } from "@/lib/api-error";
import type { ChatSession } from "@/hooks/use-chat-sessions";

/** Chat 业务 hook 入参。 */
interface UseChatBusinessOptions {
	/** 当前会话；session 生命周期由 useChatSessions 控制。 */
	session: ChatSession | null;
	/** 当前会话的 client events。 */
	clientEvents: ClientEvent[];
	/** 当前会话的 worker timeline。 */
	timeline: TimelineEvent[];
	/** 设置当前会话，用于接收 SSE session frame。 */
	setSession: (session: ChatSession) => void;
	/** 确保有可发送消息的会话。 */
	ensureSession: (firstMessage: string) => Promise<ChatSession>;
	/** 重新加载会话列表。 */
	loadSessions: (projectId?: string) => Promise<ChatSession[]>;
	/** 添加 client event。 */
	appendClientEvent: (event: ClientEvent) => void;
	/** 更新指定 client event。 */
	updateClientEvent: (eventId: string, update: (event: ClientEvent) => ClientEvent) => void;
	/** 添加 timeline event。 */
	appendTimelineEvent: (event: TimelineEvent) => void;
	/** 用户主动发送时请求滚动到底部。 */
	onRequestScrollToBottom?: () => void;
}

/**
 * 校验响应是否为 SSE。
 * @param response fetch 响应
 */
function assertSseResponse(response: Response) {
	const contentType = response.headers.get("content-type") ?? "";
	// 后端如果退化成普通流或 JSON 200，前端不能继续按 SSE 静默解析。
	if (!contentType.toLowerCase().startsWith("text/event-stream")) {
		throw new Error(`Chat stream content-type is invalid: ${contentType || "missing"}`);
	}
}

/**
 * 解析一段 SSE frame。
 * @param frame 原始 frame
 * @returns 解析后的事件；注释或空 frame 返回 null
 */
function parseSseFrame(frame: string): { event: string; data: string; id?: number } | null {
	const lines = frame.split(/\r?\n/);
	let event = "message";
	let id: number | undefined;
	const data: string[] = [];
	for (const line of lines) {
		if (!line || line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("event:")) {
			event = line.slice("event:".length).trim();
			continue;
		}
		if (line.startsWith("id:")) {
			const parsed = Number(line.slice("id:".length).trim());
			id = Number.isNaN(parsed) ? undefined : parsed;
			continue;
		}
		if (line.startsWith("data:")) {
			data.push(line.slice("data:".length).trimStart());
		}
	}
	return data.length > 0 ? { event, data: data.join("\n"), id } : null;
}

/**
 * 解析 SSE JSON 负载，并把坏数据转换为可展示的错误。
 * @param data SSE data 文本
 * @returns JSON 对象
 */
function parseSseJson(data: string): Record<string, unknown> {
	try {
		return JSON.parse(data) as Record<string, unknown>;
	} catch {
		throw new Error("Timeline stream payload parse failed");
	}
}

/**
 * Chat 消息输入、SSE 流和运行期交互状态。
 *
 * 形态参考 AI SDK useChat：hook 内部持有流式请求控制、输入框状态和运行期错误，
 * 对页面返回 messages / status / error / input state / action helpers。
 * @param options hook 运行所需外部上下文
 * @returns chat 运行期状态与动作
 */
export function useChatBusiness(options: UseChatBusinessOptions) {
	const {
		appendClientEvent,
		appendTimelineEvent,
		clientEvents,
		ensureSession,
		loadSessions,
		onRequestScrollToBottom,
		session,
		setSession,
		timeline,
		updateClientEvent,
	} = options;
	const streamAbortRef = useRef<AbortController | null>(null);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSending, setIsSending] = useState(false);
	const [timelineStreamStatus, setTimelineStreamStatus] = useState<
		"idle" | "connecting" | "open"
	>("idle");
	const [handledPermissionRequestIds, setHandledPermissionRequestIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [isPermissionSubmitting, setIsPermissionSubmitting] = useState(false);
	const [permissionError, setPermissionError] = useState<string | null>(null);

	const messages = useMemo(() => {
		return buildMessages(clientEvents, timeline);
	}, [clientEvents, timeline]);

	const pendingPermissionRequest = useMemo(() => {
		return findPendingToolPermissionRequest(
			timeline,
			clientEvents,
			handledPermissionRequestIds,
		);
	}, [clientEvents, handledPermissionRequestIds, timeline]);

	/**
	 * 关闭当前 chat stream。
	 */
	function closeTimelineStream() {
		streamAbortRef.current?.abort();
		streamAbortRef.current = null;
		setTimelineStreamStatus("idle");
	}

	/**
	 * 重置 chat 运行期状态。
	 */
	function resetChatRuntime() {
		closeTimelineStream();
		setHandledPermissionRequestIds(new Set());
		setPermissionError(null);
	}

	/**
	 * 提交 Claude Code 工具权限决策。
	 * @param request 权限申请
	 * @param decision 用户决策
	 */
	async function submitToolPermissionDecision(
		request: ToolPermissionRequest,
		decision: "allow" | "deny",
	) {
		if (!session) {
			return;
		}
		setIsPermissionSubmitting(true);
		setPermissionError(null);
		try {
			const response = await fetch(`/api/ccr/sessions/${session.id}/tool-permission`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: request.requestId,
					decision,
				}),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as { event?: ClientEvent };
			setHandledPermissionRequestIds((current) => {
				const next = new Set(current);
				// 响应已写入 client event 队列，本地先标记避免弹窗重复阻塞。
				next.add(request.requestId);
				return next;
			});
			if (body.event) {
				appendClientEvent(body.event);
			}
		} catch (err) {
			setPermissionError(err instanceof Error ? err.message : "权限响应提交失败");
		} finally {
			setIsPermissionSubmitting(false);
		}
	}

	/**
	 * 处理 chat SSE frame。
	 * @param frame 原始 frame
	 * @param sessionId session ID
	 * @returns 是否收到结束事件
	 */
	function handleChatStreamFrame(frame: string, sessionId: string): boolean {
		const parsed = parseSseFrame(frame);
		if (!parsed) {
			return false;
		}
		if (parsed.event === "session") {
			const body = parseSseJson(parsed.data) as { session: ChatSession | null };
			if (body.session) {
				setSession(body.session);
			}
			return false;
		}
		if (parsed.event === "timeline") {
			const body = parseSseJson(parsed.data) as {
				session_id: string;
				event: TimelineEvent;
			};
			if (body.session_id === sessionId) {
				appendTimelineEvent(body.event);
			}
			return false;
		}
		if (parsed.event === "error") {
			const body = parseSseJson(parsed.data);
			throw new Error(typeof body.error === "string" ? body.error : "Chat stream failed");
		}
		return parsed.event === "done";
	}

	/**
	 * 通过 chat API 发送消息并读取同一请求返回的 SSE。
	 * @param sessionId session ID
	 * @param content 用户消息
	 * @param cursor timeline 游标
	 */
	async function streamMessage(sessionId: string, content: string, cursor: number) {
		closeTimelineStream();
		const controller = new AbortController();
		streamAbortRef.current = controller;
		setTimelineStreamStatus("connecting");
		const response = await fetch(
			`/api/ccr/sessions/${sessionId}/messages?cursor=${cursor}`,
			{
				method: "POST",
				headers: {
					accept: "text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({ message: content }),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		assertSseResponse(response);
		if (!response.body) {
			throw new Error("Chat stream response body is empty");
		}
		setTimelineStreamStatus("open");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split(/\n\n/);
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					if (handleChatStreamFrame(frame, sessionId)) {
						return;
					}
				}
			}
			if (buffer && handleChatStreamFrame(buffer, sessionId)) {
				return;
			}
		} catch (err) {
			// 用户切换会话或离开页面时主动 abort，不应该展示为操作失败。
			if (err instanceof DOMException && err.name === "AbortError") {
				return;
			}
			throw err;
		} finally {
			if (streamAbortRef.current === controller) {
				streamAbortRef.current = null;
				setTimelineStreamStatus("idle");
			}
		}
	}

	/**
	 * 发送当前输入。
	 */
	async function sendMessage() {
		const content = draft.trim();
		if (!content || isSending) {
			return;
		}
		setError(null);
		setIsSending(true);
		setDraft("");
		// 用户主动发送消息时通知页面恢复本轮输出的底部跟随。
		onRequestScrollToBottom?.();
		const optimisticEvent: ClientEvent = {
			event_id: crypto.randomUUID(),
			sequence_num: Date.now(),
			event_type: "user",
			source: "browser",
			payload: {
				message: {
					role: "user",
					content,
				},
			},
			created_at: new Date().toISOString(),
		};
		appendClientEvent(optimisticEvent);
		try {
			const activeSession = await ensureSession(content);
			const cursor = timeline.reduce((maxId, event) => Math.max(maxId, event.id), 0);
			await streamMessage(activeSession.id, content, cursor);
			await loadSessions(activeSession.projectId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			updateClientEvent(optimisticEvent.event_id, (event) => ({
				...event,
				payload: {
					...event.payload,
					error: "send_failed",
				},
			}));
			setDraft(content);
		} finally {
			setIsSending(false);
		}
	}

	return {
		closeTimelineStream,
		draft,
		error,
		isPermissionSubmitting,
		isSending,
		messages,
		pendingPermissionRequest,
		permissionError,
		resetChatRuntime,
		sendMessage,
		setDraft,
		setError,
		submitToolPermissionDecision,
		timelineStreamStatus,
	};
}
