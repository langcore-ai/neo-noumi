import { useCallback, useRef, useState } from "react";
import type { ClientEvent, TimelineEvent } from "@/lib/chat-message-model";
import { readError } from "@/lib/api-error";

/** 默认会话标题，用户直接发送第一条消息时使用。 */
export const DEFAULT_SESSION_TITLE = "新的对话";

/** Chat 页面每次加载的历史事件数量。 */
const CHAT_HISTORY_PAGE_SIZE = 10;

/** Chat 页 URL 查询参数。 */
export interface ChatSearch {
	/** 初始选中的 project ID；没有 sessionId 时表示打开该 project 的新对话。 */
	projectId?: string;
	/** 初始选中的 session ID。 */
	sessionId?: string;
}

/** CCR 会话摘要。 */
export interface ChatSession {
	id: string;
	title: string | null;
	projectId: string;
	workerStatus: string;
	containerStatus: string;
	sandboxId: string | null;
	workerEpoch: number;
	updatedAt: string;
}

/** CCR 项目摘要。 */
export interface Project {
	id: string;
	name: string;
	description: string | null;
	updatedAt: string;
}

/** 会话详情接口响应。 */
interface SessionDetailResponse {
	session: ChatSession;
	clientEvents?: ClientEvent[];
	timeline: TimelineEvent[];
	history?: SessionHistoryState;
}

/** 会话历史分页状态。 */
interface SessionHistoryState {
	/** 是否还有更早的用户事件。 */
	hasMoreClientEvents: boolean;
	/** 是否还有更早的 worker timeline。 */
	hasMoreTimeline: boolean;
	/** 当前已加载用户事件中的最早 sequence。 */
	beforeClientSequence: number | null;
	/** 当前已加载 timeline 中的最早 ID。 */
	beforeTimelineId: number | null;
}

/** 空历史分页状态。 */
const EMPTY_SESSION_HISTORY: SessionHistoryState = {
	hasMoreClientEvents: false,
	hasMoreTimeline: false,
	beforeClientSequence: null,
	beforeTimelineId: null,
};

/** Chat session hook 入参。 */
interface UseChatSessionsOptions {
	/** 当前选中的 project。 */
	project: Project | null;
	/** 设置当前 project。 */
	setProject: (project: Project) => void;
	/** 同步 chat 页面路由查询参数。 */
	updateChatRouteSearch: (search: ChatSearch, replace?: boolean) => void;
	/** 切换会话时请求页面滚动到底部。 */
	onRequestScrollToBottom?: () => void;
}

/**
 * 合并并排序 client events，避免历史分页和乐观事件重复展示。
 * @param current 当前 events
 * @param next 新 events
 * @returns 合并后的 events
 */
function mergeClientEvents(current: ClientEvent[], next: ClientEvent[]) {
	const byEventId = new Map(current.map((event) => [event.event_id, event]));
	for (const event of next) {
		byEventId.set(event.event_id, event);
	}
	return [...byEventId.values()].sort((a, b) => a.sequence_num - b.sequence_num);
}

/**
 * Chat 会话、会话列表与历史分页控制。
 * @param options hook 运行所需外部上下文
 * @returns session 业务状态与动作
 */
export function useChatSessions(options: UseChatSessionsOptions) {
	const { onRequestScrollToBottom, project, setProject, updateChatRouteSearch } = options;
	const timelineIdsRef = useRef<Set<number>>(new Set());
	const [session, setSession] = useState<ChatSession | null>(null);
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [clientEvents, setClientEvents] = useState<ClientEvent[]>([]);
	const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
	const [sessionHistory, setSessionHistory] = useState<SessionHistoryState>(
		EMPTY_SESSION_HISTORY,
	);
	const [containerStatus, setContainerStatus] = useState<unknown>(null);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);
	const [sessionError, setSessionError] = useState<string | null>(null);

	/**
	 * 重置当前会话详情。
	 */
	const resetConversation = useCallback(() => {
		setSession(null);
		setClientEvents([]);
		setTimeline([]);
		setSessionHistory(EMPTY_SESSION_HISTORY);
		setContainerStatus(null);
		setSessionError(null);
		timelineIdsRef.current = new Set();
	}, []);

	/**
	 * 合并 timeline 事件，避免 SSE 重连或快照返回造成重复展示。
	 * @param event 新 timeline 事件
	 */
	const appendTimelineEvent = useCallback((event: TimelineEvent) => {
		if (timelineIdsRef.current.has(event.id)) {
			return;
		}
		timelineIdsRef.current.add(event.id);
		setTimeline((current) => {
			return [...current, event].sort((a, b) => a.id - b.id);
		});
	}, []);

	/**
	 * 添加 client event。
	 * @param event 新 client event
	 */
	const appendClientEvent = useCallback((event: ClientEvent) => {
		setClientEvents((current) => [...current, event]);
	}, []);

	/**
	 * 更新指定 client event。
	 * @param eventId client event ID
	 * @param update 更新函数
	 */
	const updateClientEvent = useCallback(
		(eventId: string, update: (event: ClientEvent) => ClientEvent) => {
			setClientEvents((current) => {
				return current.map((event) => (event.event_id === eventId ? update(event) : event));
			});
		},
		[],
	);

	/**
	 * 合并并排序 timeline events，避免历史分页和 SSE 重连重复展示。
	 * @param current 当前 events
	 * @param next 新 events
	 * @returns 合并后的 events
	 */
	function mergeTimelineEvents(current: TimelineEvent[], next: TimelineEvent[]) {
		const byId = new Map(current.map((event) => [event.id, event]));
		for (const event of next) {
			byId.set(event.id, event);
			timelineIdsRef.current.add(event.id);
		}
		return [...byId.values()].sort((a, b) => a.id - b.id);
	}

	/**
	 * 加载指定项目下的会话。
	 * @param projectId 项目 ID
	 */
	const loadSessions = useCallback(async (projectId?: string) => {
		const url = projectId ? `/api/projects/${projectId}/sessions` : "/api/ccr/sessions";
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as { sessions: ChatSession[] };
		setSessions(body.sessions);
		return body.sessions;
	}, []);

	/**
	 * 加载会话详情和历史消息。
	 * @param sessionId session ID
	 * @param loadOptions 加载选项
	 * @returns 已加载的 session
	 */
	const loadSession = useCallback(
		async (
			sessionId: string,
			loadOptions: { syncRoute?: boolean } = {},
		): Promise<ChatSession> => {
			const response = await fetch(
				`/api/ccr/sessions/${sessionId}?limit=${CHAT_HISTORY_PAGE_SIZE}`,
			);
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as SessionDetailResponse;
			// 切换历史会话时通知页面滚动到底部。
			onRequestScrollToBottom?.();
			setSession(body.session);
			setClientEvents(body.clientEvents ?? []);
			timelineIdsRef.current = new Set(body.timeline.map((event) => event.id));
			setTimeline(body.timeline);
			setSessionHistory(body.history ?? EMPTY_SESSION_HISTORY);
			setSessionError(null);
			if (loadOptions.syncRoute ?? true) {
				updateChatRouteSearch({
					projectId: body.session.projectId,
					sessionId: body.session.id,
				});
			}
			return body.session;
		},
		[onRequestScrollToBottom, updateChatRouteSearch],
	);

	/**
	 * 向上滚动触顶时加载更早的会话历史。
	 */
	const loadOlderSessionHistory = useCallback(async () => {
		if (
			!session ||
			isLoadingHistory ||
			(!sessionHistory.hasMoreClientEvents && !sessionHistory.hasMoreTimeline)
		) {
			return;
		}
		const params = new URLSearchParams({
			older: "1",
			limit: String(CHAT_HISTORY_PAGE_SIZE),
		});
		if (sessionHistory.hasMoreClientEvents && sessionHistory.beforeClientSequence) {
			params.set("beforeClientSequence", String(sessionHistory.beforeClientSequence));
		}
		if (sessionHistory.hasMoreTimeline && sessionHistory.beforeTimelineId) {
			params.set("beforeTimelineId", String(sessionHistory.beforeTimelineId));
		}
		setIsLoadingHistory(true);
		setSessionError(null);
		try {
			const response = await fetch(`/api/ccr/sessions/${session.id}?${params}`);
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as SessionDetailResponse;
			setClientEvents((current) => mergeClientEvents(body.clientEvents ?? [], current));
			setTimeline((current) => mergeTimelineEvents(body.timeline, current));
			setSessionHistory(body.history ?? EMPTY_SESSION_HISTORY);
		} catch (err) {
			setSessionError(err instanceof Error ? err.message : "加载历史消息失败");
		} finally {
			setIsLoadingHistory(false);
		}
	}, [isLoadingHistory, session, sessionHistory]);

	/**
	 * 自动确保有可发送消息的会话。
	 * @param firstMessage 第一条消息内容，用作会话标题
	 * @returns session
	 */
	const ensureSession = useCallback(
		async (firstMessage: string): Promise<ChatSession> => {
			if (session) {
				return session;
			}
			const response = await fetch(
				project ? `/api/projects/${project.id}/sessions` : "/api/ccr/sessions",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: firstMessage.slice(0, 48) || DEFAULT_SESSION_TITLE,
					}),
				},
			);
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as {
				session: ChatSession;
				project?: Project;
			};
			if (body.project) {
				setProject(body.project);
			}
			setSession(body.session);
			timelineIdsRef.current = new Set();
			setTimeline([]);
			setSessionHistory(EMPTY_SESSION_HISTORY);
			updateChatRouteSearch({
				projectId: body.session.projectId,
				sessionId: body.session.id,
			});
			await loadSessions(body.session.projectId);
			return body.session;
		},
		[loadSessions, project, session, setProject, updateChatRouteSearch],
	);

	/**
	 * 新建空白对话。
	 */
	const startNewConversation = useCallback(() => {
		resetConversation();
		updateChatRouteSearch(project ? { projectId: project.id } : {});
	}, [project, resetConversation, updateChatRouteSearch]);

	/**
	 * 删除指定会话。
	 * @param sessionId session ID
	 */
	const deleteSession = useCallback(
		async (sessionId: string) => {
			const previousSessions = sessions;
			setSessionError(null);
			// 先做乐观删除，避免后台容器清理影响列表交互。
			setSessions((current) => current.filter((item) => item.id !== sessionId));
			try {
				const response = await fetch(`/api/ccr/sessions/${sessionId}`, {
					method: "DELETE",
				});
				if (!response.ok) {
					throw new Error(await readError(response));
				}
				if (session?.id === sessionId) {
					resetConversation();
					updateChatRouteSearch(project ? { projectId: project.id } : {});
				}
			} catch (err) {
				setSessions(previousSessions);
				const message = err instanceof Error ? err.message : String(err);
				setSessionError(message);
				throw err;
			}
		},
		[project, resetConversation, session?.id, sessions, updateChatRouteSearch],
	);

	/**
	 * 查询或控制当前 session 对应容器。
	 * @param action 操作类型
	 */
	const callContainer = useCallback(
		async (action: "status" | "stop") => {
			if (!session) {
				return;
			}
			setSessionError(null);
			try {
				const response = await fetch(
					`/api/ccr/sessions/${session.id}/container/${action}`,
					{ method: action === "status" ? "GET" : "POST" },
				);
				if (!response.ok) {
					throw new Error(await readError(response));
				}
				setContainerStatus(await response.json());
				await loadSession(session.id);
			} catch (err) {
				setSessionError(err instanceof Error ? err.message : String(err));
			}
		},
		[loadSession, session],
	);

	return {
		appendClientEvent,
		appendTimelineEvent,
		callContainer,
		clientEvents,
		containerStatus,
		deleteSession,
		ensureSession,
		isLoadingHistory,
		loadOlderSessionHistory,
		loadSession,
		loadSessions,
		resetConversation,
		session,
		sessionError,
		sessions,
		setSession,
		startNewConversation,
		timeline,
		updateClientEvent,
	};
}
