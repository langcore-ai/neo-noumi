import { createFileRoute, Link } from "@tanstack/react-router";
import {
	BotIcon,
	CheckCircle2Icon,
	ChevronRightIcon,
	ClockIcon,
	Loader2Icon,
	MessageSquarePlusIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	SendIcon,
	SquareIcon,
	Trash2Icon,
	UserIcon,
	WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	Avatar,
	AvatarBadge,
	AvatarFallback,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chat")({
	component: ChatPage,
});

/** CCR 会话摘要。 */
interface ChatSession {
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
interface Project {
	id: string;
	name: string;
	description: string | null;
	updatedAt: string;
}

/** Worker 写入的可见 timeline 事件。 */
interface TimelineEvent {
	id: number;
	event_id: string;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: string;
	ephemeral: boolean;
}

/** 用户发送后写入的 client event。 */
interface ClientEvent {
	event_id: string;
	sequence_num: number;
	event_type: string;
	source: string;
	payload: Record<string, unknown>;
	created_at: string;
}

/** 页面消息模型，用于把用户消息和 worker timeline 统一渲染。 */
interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	createdAt: string;
	status?: "pending" | "streaming" | "done" | "error";
	meta?: string;
	raw?: unknown;
}

/** 会话详情接口响应。 */
interface SessionDetailResponse {
	session: ChatSession;
	clientEvents?: ClientEvent[];
	timeline: TimelineEvent[];
}

/** 默认会话标题，用户直接发送第一条消息时使用。 */
const DEFAULT_SESSION_TITLE = "新的对话";

/** 空输入占位文案。 */
const MESSAGE_PLACEHOLDER = "描述你想完成的任务，或者粘贴错误、需求、代码片段。";

/**
 * 从 API 响应中读取错误消息。
 * @param response fetch 响应
 * @returns 错误消息
 */
async function readError(response: Response): Promise<string> {
	const body = await response.json().catch(() => ({}));
	return typeof body.error === "string" ? body.error : response.statusText;
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
 * 判断值是否是普通对象。
 * @param value 待判断值
 * @returns 是否是对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
		"tool_use",
		"tool_result",
		"thinking",
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
	const isAssistant = displayType === "assistant";
	const isResult = event.event_type === "result" || event.payload.type === "result";
	return {
		id: `timeline-${event.id}`,
		role: isAssistant ? "assistant" : isSupportTimelineEvent({ ...event, event_type: displayType }) ? "tool" : "system",
		content: extractWorkerText(event.payload),
		createdAt: event.created_at,
		status: isResult ? "done" : event.ephemeral ? "streaming" : "done",
		meta: displayType,
		raw: event.payload,
	};
}

/**
 * 生成工具调用的折叠摘要。
 * @param raw 原始 timeline payload
 * @returns 工具调用摘要
 */
function getToolUseSummary(raw: unknown): string {
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
 * 合并并排序历史消息。
 * @param clientEvents 用户事件
 * @param timeline worker timeline
 * @returns 页面消息列表
 */
function buildMessages(
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
 * 格式化相对简短的时间。
 * @param value ISO 时间
 * @returns 本地时间文本
 */
function formatTime(value: string): string {
	return new Date(value).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
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
 * 产品化 Chat 页面。
 * @returns Chat 页面组件
 */
function ChatPage() {
	const authSession = authClient.useSession();
	const streamAbortRef = useRef<AbortController | null>(null);
	const timelineIdsRef = useRef<Set<number>>(new Set());
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const [session, setSession] = useState<ChatSession | null>(null);
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [project, setProject] = useState<Project | null>(null);
	const [clientEvents, setClientEvents] = useState<ClientEvent[]>([]);
	const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
	const [draft, setDraft] = useState("");
	const [containerStatus, setContainerStatus] = useState<unknown>(null);
	const [error, setError] = useState<string | null>(null);
	const [isBootstrapping, setIsBootstrapping] = useState(true);
	const [isSending, setIsSending] = useState(false);
	const [timelineStreamStatus, setTimelineStreamStatus] = useState<
		"idle" | "connecting" | "open"
	>("idle");

	const messages = useMemo(() => {
		return buildMessages(clientEvents, timeline);
	}, [clientEvents, timeline]);

	const latestSessionTitle = session?.title || DEFAULT_SESSION_TITLE;

	/**
	 * 关闭当前 chat stream。
	 */
	function closeTimelineStream() {
		streamAbortRef.current?.abort();
		streamAbortRef.current = null;
		setTimelineStreamStatus("idle");
	}

	/**
	 * 重置当前会话详情。
	 */
	function resetConversation() {
		closeTimelineStream();
		setSession(null);
		setClientEvents([]);
		setTimeline([]);
		setContainerStatus(null);
		timelineIdsRef.current = new Set();
	}

	/**
	 * 合并 timeline 事件，避免 SSE 重连或快照返回造成重复展示。
	 * @param event 新 timeline 事件
	 */
	function appendTimelineEvent(event: TimelineEvent) {
		if (timelineIdsRef.current.has(event.id)) {
			return;
		}
		timelineIdsRef.current.add(event.id);
		setTimeline((current) => {
			return [...current, event].sort((a, b) => a.id - b.id);
		});
	}

	/**
	 * 加载项目列表。
	 */
	async function loadProjects() {
		const response = await fetch("/api/projects");
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as { projects: Project[] };
		setProjects(body.projects);
		setProject((current) => current ?? body.projects[0] ?? null);
		return body.projects;
	}

	/**
	 * 加载指定项目下的会话。
	 * @param projectId 项目 ID
	 */
	async function loadSessions(projectId?: string) {
		const url = projectId
			? `/api/projects/${projectId}/sessions`
			: "/api/ccr/sessions";
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as { sessions: ChatSession[] };
		setSessions(body.sessions);
		return body.sessions;
	}

	/**
	 * 加载会话详情和历史消息。
	 * @param sessionId session ID
	 */
	async function loadSession(sessionId: string) {
		closeTimelineStream();
		const response = await fetch(`/api/ccr/sessions/${sessionId}`);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as SessionDetailResponse;
		setSession(body.session);
		setClientEvents(body.clientEvents ?? []);
		timelineIdsRef.current = new Set(body.timeline.map((event) => event.id));
		setTimeline(body.timeline);
	}

	/**
	 * 自动确保有可发送消息的会话。
	 * @param firstMessage 第一条消息内容，用作会话标题
	 * @returns session
	 */
	async function ensureSession(firstMessage: string): Promise<ChatSession> {
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
		await loadSessions(body.session.projectId);
		return body.session;
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
		setClientEvents((current) => [...current, optimisticEvent]);
		try {
			const activeSession = await ensureSession(content);
			const cursor = timeline.reduce((maxId, event) => Math.max(maxId, event.id), 0);
			await streamMessage(activeSession.id, content, cursor);
			await loadSessions(activeSession.projectId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setClientEvents((current) => {
				return current.map((event) => {
					return event.event_id === optimisticEvent.event_id
						? {
								...event,
								payload: {
									...event.payload,
									error: "send_failed",
								},
							}
						: event;
				});
			});
			setDraft(content);
		} finally {
			setIsSending(false);
		}
	}

	/**
	 * 新建空白对话。
	 */
	function startNewConversation() {
		resetConversation();
		setDraft("");
		setError(null);
	}

	/**
	 * 删除指定会话。
	 * @param sessionId session ID
	 */
	async function deleteSession(sessionId: string) {
		const previousSessions = sessions;
		setError(null);
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
			}
		} catch (err) {
			setSessions(previousSessions);
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * 查询或控制当前 session 对应容器。
	 * @param action 操作类型
	 */
	async function callContainer(action: "status" | "stop") {
		if (!session) {
			return;
		}
		setError(null);
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
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	useEffect(() => {
		if (authSession.isPending || !authSession.data) {
			return;
		}
		void (async () => {
			try {
				const loadedProjects = await loadProjects();
				const firstProject = loadedProjects[0];
				const loadedSessions = await loadSessions(firstProject?.id);
				if (firstProject) {
					setProject(firstProject);
				}
				if (loadedSessions[0]) {
					await loadSession(loadedSessions[0].id);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsBootstrapping(false);
			}
		})();
		return () => closeTimelineStream();
		// 初始化流程只应执行一次；loader 使用当前闭包避免重复选择首个会话。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [authSession.isPending, authSession.data]);

	useEffect(() => {
		if (isBootstrapping || authSession.isPending || !authSession.data) {
			return;
		}
		void loadSessions(project?.id).catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
		});
	}, [project?.id, isBootstrapping, authSession.isPending, authSession.data]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages.length, isSending]);

	if (authSession.isPending) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
				<div className="flex w-full max-w-md flex-col gap-3">
					<Skeleton className="h-10 w-40" />
					<Skeleton className="h-28" />
					<Skeleton className="h-28" />
				</div>
			</main>
		);
	}

	if (!authSession.data) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>登录后开始对话</CardTitle>
						<CardDescription>
							Chat 会保存你的项目、历史会话和 Sandbox 运行状态。
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<Link to="/login" className={buttonVariants({ className: "w-full" })}>
							登录
						</Link>
						<Link
							to="/register"
							className={buttonVariants({ variant: "outline", className: "w-full" })}
						>
							注册账号
						</Link>
						<Link
							to="/"
							className={buttonVariants({ variant: "link", className: "w-fit px-0" })}
						>
							返回首页
						</Link>
					</CardContent>
				</Card>
			</main>
		);
	}

	return (
		<main className="flex h-dvh overflow-hidden bg-background text-foreground">
			<aside className="hidden min-h-0 w-80 shrink-0 border-r bg-muted/25 lg:flex lg:flex-col">
				<div className="flex shrink-0 items-center justify-between gap-3 border-b p-4">
					<div>
						<h1 className="text-base font-semibold">Neo Noumi Chat</h1>
						<p className="text-sm text-muted-foreground">
							{project?.name ?? "默认工作区"}
						</p>
					</div>
					<Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
						首页
					</Link>
				</div>

				<div className="flex shrink-0 flex-col gap-3 p-4">
					<Button onClick={startNewConversation}>
						<MessageSquarePlusIcon data-icon="inline-start" />
						新对话
					</Button>
					{projects.length > 1 ? (
						<div className="flex flex-col gap-2">
							<p className="text-xs font-medium text-muted-foreground">工作区</p>
							{projects.map((item) => (
								<Button
									key={item.id}
									variant={project?.id === item.id ? "secondary" : "ghost"}
									className="justify-start"
									onClick={() => {
										setProject(item);
										resetConversation();
									}}
								>
									{item.name}
								</Button>
							))}
						</div>
					) : null}
				</div>

				<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 pb-4">
					<p className="px-1 text-xs font-medium text-muted-foreground">历史对话</p>
					{isBootstrapping ? (
						<div className="flex flex-col gap-2">
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
						</div>
					) : sessions.length === 0 ? (
						<div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
							还没有会话，发送第一条消息即可开始。
						</div>
					) : (
						sessions.map((item) => (
							<div
								key={item.id}
								className={cn(
									"grid grid-cols-[minmax(0,1fr)_auto] gap-1 rounded-lg p-1",
									session?.id === item.id ? "bg-background shadow-sm" : "hover:bg-muted",
								)}
							>
								<button
									type="button"
									className="min-w-0 rounded-md px-2 py-2 text-left"
									onClick={() => void loadSession(item.id)}
								>
									<span className="block truncate text-sm font-medium">
										{item.title || DEFAULT_SESSION_TITLE}
									</span>
									<span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
										<ClockIcon />
										{new Date(item.updatedAt).toLocaleDateString()}
									</span>
								</button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`删除 ${item.title || DEFAULT_SESSION_TITLE}`}
									onClick={() => void deleteSession(item.id)}
								>
									<Trash2Icon />
								</Button>
							</div>
						))
					)}
				</div>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-1 flex-col">
				<header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="truncate text-base font-semibold">{latestSessionTitle}</h2>
							{timelineStreamStatus === "open" || isSending ? (
								<Badge variant="secondary">
									<Loader2Icon data-icon="inline-start" />
									运行中
								</Badge>
							) : (
								<Badge variant="outline">
									<CheckCircle2Icon data-icon="inline-start" />
									就绪
								</Badge>
							)}
						</div>
						<p className="truncate text-sm text-muted-foreground">
							{session?.id ?? "发送消息后会自动创建会话"}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Link
							to="/"
							className={buttonVariants({
								variant: "outline",
								size: "sm",
								className: "hidden sm:inline-flex",
							})}
						>
							首页
						</Link>
						<Button variant="outline" size="sm" onClick={startNewConversation}>
							<MessageSquarePlusIcon data-icon="inline-start" />
							新对话
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!session}
							onClick={() => void callContainer("status")}
						>
							<RefreshCwIcon data-icon="inline-start" />
							状态
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!session}
							onClick={() => void callContainer("stop")}
						>
							<SquareIcon data-icon="inline-start" />
							停止容器
						</Button>
					</div>
				</header>

				<div className="shrink-0 border-b bg-muted/20 px-4 py-3 lg:hidden">
					<div className="flex gap-2 overflow-x-auto">
						{sessions.length === 0 ? (
							<span className="text-sm text-muted-foreground">
								暂无历史对话
							</span>
						) : (
							sessions.map((item) => (
								<Button
									key={item.id}
									variant={session?.id === item.id ? "secondary" : "outline"}
									size="sm"
									className="max-w-56 shrink-0"
									onClick={() => void loadSession(item.id)}
								>
									<span className="truncate">
										{item.title || DEFAULT_SESSION_TITLE}
									</span>
								</Button>
							))
						)}
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-auto px-4 py-6">
					<div className="mx-auto flex max-w-4xl flex-col gap-4">
						{error ? (
							<Alert variant="destructive">
								<AlertTitle>操作失败</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}

						{containerStatus ? (
							<Card size="sm">
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<WrenchIcon />
										运行状态
									</CardTitle>
									<CardDescription>容器状态的原始摘要。</CardDescription>
								</CardHeader>
								<CardContent>
									<pre className="max-h-44 overflow-auto rounded-lg bg-muted p-3 text-xs">
										{JSON.stringify(containerStatus, null, 2)}
									</pre>
								</CardContent>
							</Card>
						) : null}

						{isBootstrapping ? (
							<div className="flex flex-col gap-4">
								<Skeleton className="h-24" />
								<Skeleton className="h-24" />
								<Skeleton className="h-24" />
							</div>
						) : messages.length === 0 ? (
							<div className="mx-auto flex min-h-[420px] max-w-2xl flex-col items-center justify-center gap-4 text-center">
								<div className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
									<BotIcon />
								</div>
								<div className="flex flex-col gap-2">
									<h3 className="text-2xl font-semibold">开始一次真实对话</h3>
									<p className="text-muted-foreground">
										直接描述要完成的任务。系统会自动创建会话、启动 Sandbox，并把
										Claude Code 的回复持续写回这里。
									</p>
								</div>
								<div className="grid w-full gap-2 text-left sm:grid-cols-3">
									{[
										"帮我定位一个前端报错",
										"根据需求实现一个页面",
										"解释这段代码的风险",
									].map((suggestion) => (
										<Button
											key={suggestion}
											variant="outline"
											className="h-auto justify-between whitespace-normal py-3 text-left"
											onClick={() => setDraft(suggestion)}
										>
											{suggestion}
											<ChevronRightIcon data-icon="inline-end" />
										</Button>
									))}
								</div>
							</div>
						) : (
							messages.map((message) => (
								<MessageBubble key={message.id} message={message} />
							))
						)}

						{isSending ? (
							<div className="flex items-center gap-3 text-sm text-muted-foreground">
								<Loader2Icon className="animate-spin" />
								正在等待回复...
							</div>
						) : null}
						<div ref={messagesEndRef} />
					</div>
				</div>

				<footer className="shrink-0 border-t bg-background px-4 py-4">
					<div className="mx-auto flex max-w-4xl flex-col gap-3">
						<div className="rounded-xl border bg-card p-2 shadow-sm">
							<Textarea
								value={draft}
								disabled={isSending}
								className="min-h-24 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
								placeholder={MESSAGE_PLACEHOLDER}
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										void sendMessage();
									}
								}}
							/>
							<div className="flex items-center justify-between gap-3 px-1 pb-1">
								<p className="text-xs text-muted-foreground">按 Cmd/Ctrl + Enter 发送</p>
								<Button disabled={!draft.trim() || isSending} onClick={sendMessage}>
									{isSending ? (
										<Loader2Icon data-icon="inline-start" className="animate-spin" />
									) : (
										<SendIcon data-icon="inline-start" />
									)}
									发送
								</Button>
							</div>
						</div>
					</div>
				</footer>
			</section>
		</main>
	);
}

/**
 * 单条聊天消息。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
function MessageBubble({ message }: { message: ChatMessage }) {
	const isUser = message.role === "user";
	const isTool = message.role === "tool";
	const isThinking = message.meta === "thinking";
	const isToolUse = message.meta === "tool_use";
	const isCollapsedRawEvent =
		isTool && ["system", "result", "thinking", "tool_use"].includes(message.meta ?? "");
	return (
		<article
			className={cn(
				"flex gap-3",
				isUser ? "justify-end" : "justify-start",
			)}
		>
			{!isUser ? (
				<Avatar className="mt-1">
					<AvatarFallback>{isTool ? <WrenchIcon /> : <BotIcon />}</AvatarFallback>
					{message.status === "streaming" ? <AvatarBadge /> : null}
				</Avatar>
			) : null}
			<div
				className={cn(
					"flex max-w-[82%] flex-col gap-2 rounded-xl px-4 py-3 text-sm",
					isUser
						? "bg-primary text-primary-foreground"
						: isTool
							? "border bg-muted/40 text-muted-foreground"
							: "border bg-card text-card-foreground",
				)}
			>
				<div className="flex items-center justify-between gap-3">
					<span className="text-xs font-medium">
						{isUser ? "你" : isTool ? message.meta || "运行事件" : "Neo Noumi"}
					</span>
					<span className="text-xs opacity-70">{formatTime(message.createdAt)}</span>
				</div>
				{isCollapsedRawEvent ? (
					<p className="text-xs text-muted-foreground">
						{isThinking
							? message.content
							: isToolUse
								? getToolUseSummary(message.raw)
								: `原始事件状态：${message.status ?? "done"}`}
					</p>
				) : (
					<p className="whitespace-pre-wrap break-words leading-6">{message.content}</p>
				)}
				{message.raw && isTool ? (
					<details className="group">
						<summary className="flex cursor-pointer items-center gap-1 text-xs">
							<MoreHorizontalIcon />
							查看原始事件
						</summary>
						<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-background p-3 text-xs">
							{JSON.stringify(message.raw, null, 2)}
						</pre>
					</details>
				) : null}
			</div>
			{isUser ? (
				<Avatar className="mt-1">
					<AvatarFallback>
						<UserIcon />
					</AvatarFallback>
				</Avatar>
			) : null}
		</article>
	);
}
