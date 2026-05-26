import { createFileRoute, Link } from "@tanstack/react-router";
import {
	hotkeysCoreFeature,
	selectionFeature,
	syncDataLoaderFeature,
} from "@headless-tree/core";
import { AssistiveTreeDescription, useTree } from "@headless-tree/react";
import {
	BotIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClockIcon,
	Edit3Icon,
	FileIcon,
	FileUpIcon,
	FolderIcon,
	FolderPlusIcon,
	FolderUpIcon,
	Loader2Icon,
	MessageSquarePlusIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	SendIcon,
	SquareIcon,
	Trash2Icon,
	UserIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WorkspaceUploadPanel, {
	type WorkspaceUploadFile,
} from "@/components/comp-549";
import { Tree, TreeItem, TreeItemLabel } from "@/components/tree";
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
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chat")({
	validateSearch: (search): ChatSearch => ({
		projectId: typeof search.projectId === "string" ? search.projectId : undefined,
		sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
	}),
	component: ChatPage,
});

/** Chat 页 URL 查询参数。 */
interface ChatSearch {
	/** 初始选中的 project ID；没有 sessionId 时表示打开该 project 的新对话。 */
	projectId?: string;
	/** 初始选中的 session ID。 */
	sessionId?: string;
}

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
	payloadDataType?: string;
	chunk: ClientEvent | TimelineEvent;
	raw?: unknown;
}

/** payload.data.type 专用气泡组件属性。 */
interface PayloadDataBubbleRendererProps {
	/** 页面消息模型。 */
	message: ChatMessage;
	/** 完整 timeline 消息 chunk，用于专用渲染器读取上下文。 */
	chunk: TimelineEvent;
	/** payload.data.type 业务类型。 */
	payloadDataType: string;
}

/** Claude Code 工具权限申请。 */
interface ToolPermissionRequest {
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

/** 会话详情接口响应。 */
interface SessionDetailResponse {
	session: ChatSession;
	clientEvents?: ClientEvent[];
	timeline: TimelineEvent[];
}

/** Project workspace 文件树节点。 */
interface WorkspaceTreeNode {
	path: string;
	name: string;
	type: "directory" | "file";
	size?: number;
	uploaded?: string;
}

/** workspace tree API 响应。 */
interface WorkspaceTreeResponse {
	workspace: {
		nodes: WorkspaceTreeNode[];
		truncated: boolean;
		cursor?: string;
	};
}

/** workspace 直传 URL 响应。 */
interface WorkspaceUploadUrlResponse {
	upload: {
		basePath: string;
		files: Array<{
			path: string;
			uploadUrl: string;
			method: "PUT";
			headers: Record<string, string>;
			expiresAt: number;
		}>;
	};
}

/** 前端文件树组件使用的数据项。 */
interface WorkspaceTreeItem {
	name: string;
	path: string;
	type: "directory" | "file";
	children?: string[];
	fileExtension?: string;
	size?: number;
	uploaded?: string;
	isLoaded?: boolean;
	isTruncated?: boolean;
}

/** 预览区打开的文件标签。 */
interface OpenFileTab {
	path: string;
	name: string;
}

/** 文件重命名弹窗状态。 */
interface RenameTarget {
	path: string;
	name: string;
	type: "directory" | "file";
}

/** 新建文件夹弹窗状态。 */
interface CreateDirectoryTarget {
	parentPath: string;
	parentName: string;
}

/** 上传弹窗状态。 */
interface UploadTarget {
	parentPath: string;
	parentName: string;
	mode: "files" | "directory";
}

/** 默认会话标题，用户直接发送第一条消息时使用。 */
const DEFAULT_SESSION_TITLE = "新的对话";

/** 空输入占位文案。 */
const MESSAGE_PLACEHOLDER = "描述你想完成的任务，或者粘贴错误、需求、代码片段。";

/** 文件树根节点 ID。 */
const WORKSPACE_ROOT_ID = "root";

/** 文件树缩进宽度。 */
const WORKSPACE_TREE_INDENT = 18;

/** 判断 chat 是否仍贴近底部的像素阈值。 */
const CHAT_BOTTOM_STICK_THRESHOLD = 48;

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
 * 读取文件扩展名。
 * @param name 文件名
 * @returns 小写扩展名
 */
function getFileExtension(name: string): string | undefined {
	const parts = name.split(".");
	return parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
}

/**
 * 计算文件父目录路径。
 * @param path workspace 相对路径
 * @returns 父目录路径；根目录返回空字符串
 */
function getParentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/**
 * 计算重命名后的 workspace 路径。
 * @param path 原始路径
 * @param nextName 新名称
 * @returns 新路径
 */
function buildRenamedPath(path: string, nextName: string): string {
	const parentPath = getParentPath(path);
	return parentPath ? `${parentPath}/${nextName}` : nextName;
}

/**
 * 计算新建子目录路径。
 * @param parentPath 父目录路径
 * @param name 子目录名称
 * @returns 新目录路径
 */
function buildChildDirectoryPath(parentPath: string, name: string): string {
	return parentPath ? `${parentPath}/${name}` : name;
}

/**
 * 判断一个路径是否命中目标路径或其子路径。
 * @param path 待判断路径
 * @param target 目标路径
 * @returns 是否属于同一节点或子节点
 */
function isPathOrChild(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
}

/**
 * 将 workspace API 节点转换成文件树数据项。
 * @param node workspace 节点
 * @returns 文件树数据项
 */
function workspaceNodeToTreeItem(node: WorkspaceTreeNode): WorkspaceTreeItem {
	return {
		name: node.name,
		path: node.path,
		type: node.type,
		children: node.type === "directory" ? [] : undefined,
		fileExtension: node.type === "file" ? getFileExtension(node.name) : undefined,
		size: node.size,
		uploaded: node.uploaded,
		isLoaded: node.type === "file",
	};
}

/**
 * 构造初始 workspace 文件树。
 * @returns 文件树数据
 */
function createEmptyWorkspaceTree(): Record<string, WorkspaceTreeItem> {
	return {
		[WORKSPACE_ROOT_ID]: {
			name: "workspace",
			path: "",
			type: "directory",
			children: [],
			isLoaded: false,
		},
	};
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
function findPendingToolPermissionRequest(
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
		role: isAssistant ? "assistant" : isSupportTimelineEvent({ ...event, event_type: displayType }) ? "tool" : "system",
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
function getControlEventSummary(raw: unknown, meta: string | undefined): string {
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
 * 判断消息 chunk 是否来自 timeline。
 * @param chunk 页面消息 chunk
 * @returns 是否为完整 timeline chunk
 */
function isTimelineMessageChunk(chunk: ChatMessage["chunk"]): chunk is TimelineEvent {
	return "id" in chunk && typeof chunk.id === "number" && "payload" in chunk;
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
 * 格式化消息气泡时间。
 * @param value ISO 时间
 * @returns 精确到毫秒的本地时间文本
 */
function formatTime(value: string): string {
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
	const initialSearch = Route.useSearch();
	const bootstrappedUserIdRef = useRef<string | null>(null);
	const streamAbortRef = useRef<AbortController | null>(null);
	const timelineIdsRef = useRef<Set<number>>(new Set());
	const chatViewportRef = useRef<HTMLDivElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const forceStickToBottomRef = useRef(false);
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
	const [workspaceItems, setWorkspaceItems] = useState<Record<string, WorkspaceTreeItem>>(
		createEmptyWorkspaceTree,
	);
	const [workspaceError, setWorkspaceError] = useState<string | null>(null);
	const [hasLoadedWorkspaceTree, setHasLoadedWorkspaceTree] = useState(false);
	const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
	const [isWorkspaceMutating, setIsWorkspaceMutating] = useState(false);
	const [openFileTabs, setOpenFileTabs] = useState<OpenFileTab[]>([]);
	const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
	const [renamingTarget, setRenamingTarget] = useState<RenameTarget | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [createDirectoryTarget, setCreateDirectoryTarget] =
		useState<CreateDirectoryTarget | null>(null);
	const [createDirectoryValue, setCreateDirectoryValue] = useState("新建文件夹");
	const [uploadTarget, setUploadTarget] = useState<UploadTarget | null>(null);
	const [handledPermissionRequestIds, setHandledPermissionRequestIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [isPermissionSubmitting, setIsPermissionSubmitting] = useState(false);
	const [permissionError, setPermissionError] = useState<string | null>(null);

	const workspaceTree = useTree<WorkspaceTreeItem>({
		dataLoader: {
			getChildren: (itemId) => workspaceItems[itemId]?.children ?? [],
			getItem: (itemId) => workspaceItems[itemId],
		},
		features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
		getItemName: (item) => item.getItemData()?.name ?? "Unknown",
		indent: WORKSPACE_TREE_INDENT,
		initialState: {
			expandedItems: [WORKSPACE_ROOT_ID],
			selectedItems: activeFilePath ? [activeFilePath] : [],
		},
		isItemFolder: (item) => item.getItemData()?.type === "directory",
		rootItemId: WORKSPACE_ROOT_ID,
	});

	useEffect(() => {
		// Headless Tree 会缓存可见节点，workspace 数据更新后需要显式重建。
		workspaceTree.rebuildTree();
	}, [workspaceItems, workspaceTree]);

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

	const latestSessionTitle = session?.title || DEFAULT_SESSION_TITLE;
	const activeFileTab = openFileTabs.find((tab) => tab.path === activeFilePath) ?? null;
	const hasPreviewPanel = Boolean(activeFileTab);
	const authUserId = authSession.data?.user.id;
	const truncatedWorkspaceItems = Object.values(workspaceItems).filter(
		(item) => item.type === "directory" && item.isTruncated,
	);

	/**
	 * 关闭当前 chat stream。
	 */
	function closeTimelineStream() {
		streamAbortRef.current?.abort();
		streamAbortRef.current = null;
		setTimelineStreamStatus("idle");
	}

	/**
	 * 计算 chat viewport 距离底部的距离。
	 * @param viewport chat 滚动容器
	 * @returns 距离底部的像素数
	 */
	function getChatBottomDistance(viewport: HTMLDivElement): number {
		return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
	}

	/**
	 * 判断 chat viewport 是否应继续吸附底部。
	 * @param viewport chat 滚动容器
	 * @returns 是否接近底部
	 */
	function isChatNearBottom(viewport: HTMLDivElement): boolean {
		return getChatBottomDistance(viewport) <= CHAT_BOTTOM_STICK_THRESHOLD;
	}

	/**
	 * 记录用户当前是否仍希望跟随最新输出。
	 */
	function updateChatStickState() {
		if (!chatViewportRef.current) {
			return;
		}
		// 只有用户停留在底部附近时，后续 SSE 增量才继续自动贴底。
		shouldStickToBottomRef.current = isChatNearBottom(chatViewportRef.current);
	}

	/**
	 * 滚动 chat 到底部。
	 */
	const scrollChatToBottom = useCallback(() => {
		if (chatViewportRef.current) {
			// 流式输出频率高，直接设置 scrollTop，避免 smooth 动画抢占用户滚动。
			chatViewportRef.current.scrollTop = chatViewportRef.current.scrollHeight;
			return;
		}
		messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
	}, []);

	/**
	 * 重置当前会话详情。
	 */
	function resetConversation() {
		closeTimelineStream();
		setSession(null);
		setClientEvents([]);
		setTimeline([]);
		setContainerStatus(null);
		setHandledPermissionRequestIds(new Set());
		setPermissionError(null);
		timelineIdsRef.current = new Set();
		shouldStickToBottomRef.current = true;
		forceStickToBottomRef.current = false;
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
	 * 加载指定目录下的 workspace 文件树节点。
	 * @param projectId 项目 ID
	 * @param prefix workspace 目录路径
	 */
	async function loadWorkspaceTree(projectId: string, prefix = "") {
		setWorkspaceError(null);
		setIsWorkspaceLoading(true);
		try {
			const response = await fetch(`/api/projects/${projectId}/workspace/tree`, {
				body: JSON.stringify({ prefix }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as WorkspaceTreeResponse;
			setWorkspaceItems((current) => {
				const parentId = prefix || WORKSPACE_ROOT_ID;
				const nextItems = prefix ? { ...current } : createEmptyWorkspaceTree();
				const childIds = body.workspace.nodes.map((node) => node.path);
				for (const node of body.workspace.nodes) {
					const previous = nextItems[node.path];
					nextItems[node.path] = {
						...workspaceNodeToTreeItem(node),
						children: node.type === "directory" ? (previous?.children ?? []) : undefined,
						isLoaded: node.type === "file" ? true : (previous?.isLoaded ?? false),
					};
				}
				nextItems[parentId] = {
					...(nextItems[parentId] ?? {
						name: prefix ? prefix.split("/").pop() ?? prefix : "workspace",
						path: prefix,
						type: "directory",
					}),
					children: childIds,
					isLoaded: true,
					isTruncated: body.workspace.truncated,
				};
				return nextItems;
			});
			setHasLoadedWorkspaceTree(true);
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : "加载文件树失败");
		} finally {
			setIsWorkspaceLoading(false);
		}
	}

	/**
	 * 刷新当前 project 的 workspace 文件树。
	 */
	async function refreshWorkspaceTree() {
		if (!project) {
			return;
		}
		await loadWorkspaceTree(project.id);
	}

	/**
	 * 切换当前 project，并同步重置文件与会话上下文。
	 * @param nextProject 目标 project
	 */
	function selectProject(nextProject: Project) {
		setProject(nextProject);
		resetConversation();
		setWorkspaceItems(createEmptyWorkspaceTree());
		setHasLoadedWorkspaceTree(false);
		setOpenFileTabs([]);
		setActiveFilePath(null);
		setWorkspaceError(null);
		void loadWorkspaceTree(nextProject.id);
	}

	/**
	 * 选择文件树节点；目录会按需加载，文件会加入预览标签页。
	 * @param item 文件树数据项
	 */
	async function selectWorkspaceItem(item: WorkspaceTreeItem) {
		if (item.type === "directory") {
			if (project && !item.isLoaded) {
				await loadWorkspaceTree(project.id, item.path);
			}
			return;
		}
		setOpenFileTabs((current) => {
			return current.some((tab) => tab.path === item.path)
				? current
				: [...current, { path: item.path, name: item.name }];
		});
		setActiveFilePath(item.path);
	}

	/**
	 * 关闭文件预览标签。
	 * @param path 文件路径
	 */
	function closeFileTab(path: string) {
		setOpenFileTabs((current) => {
			const nextTabs = current.filter((tab) => tab.path !== path);
			if (activeFilePath === path) {
				setActiveFilePath(nextTabs[nextTabs.length - 1]?.path ?? null);
			}
			return nextTabs;
		});
	}

	/**
	 * 删除 workspace 文件或目录。
	 * @param item 文件树数据项
	 */
	async function deleteWorkspaceItem(item: WorkspaceTreeItem) {
		if (!project || item.path === "") {
			return;
		}
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		try {
			const response = await fetch(`/api/projects/${project.id}/workspace/file`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: item.path }),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			setOpenFileTabs((current) =>
				current.filter((tab) => !isPathOrChild(tab.path, item.path)),
			);
			if (activeFilePath && isPathOrChild(activeFilePath, item.path)) {
				setActiveFilePath(null);
			}
			await refreshWorkspaceTree();
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : "删除失败");
		} finally {
			setIsWorkspaceMutating(false);
		}
	}

	/**
	 * 打开重命名弹窗。
	 * @param item 文件树数据项
	 */
	function openRenameDialog(item: WorkspaceTreeItem) {
		setRenamingTarget({ path: item.path, name: item.name, type: item.type });
		setRenameValue(item.name);
	}

	/**
	 * 打开新建文件夹弹窗。
	 * @param parent 父目录；未传时创建到 workspace 根目录
	 */
	function openCreateDirectoryDialog(parent?: WorkspaceTreeItem) {
		setCreateDirectoryTarget({
			parentPath: parent?.path ?? "",
			parentName: parent?.name ?? "根目录",
		});
		setCreateDirectoryValue("新建文件夹");
	}

	/**
	 * 打开 workspace 上传弹窗。
	 * @param mode 上传模式
	 * @param parent 目标父目录；未传时上传到 workspace 根目录
	 */
	function openUploadDialog(mode: UploadTarget["mode"], parent?: WorkspaceTreeItem) {
		setUploadTarget({
			parentPath: parent?.path ?? "",
			parentName: parent?.name ?? "根目录",
			mode,
		});
	}

	/**
	 * 上传文件到当前 workspace。
	 * @param files 需要上传的文件列表
	 */
	async function uploadWorkspaceFiles(files: WorkspaceUploadFile[]) {
		if (!project || !uploadTarget || files.length === 0) {
			return;
		}
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		try {
			const response = await fetch(`/api/projects/${project.id}/workspace/upload-urls`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					basePath: uploadTarget.parentPath,
					files: files.map((item) => ({
						relativePath: item.relativePath,
						size: item.file.size,
						contentType: item.file.type,
					})),
				}),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as WorkspaceUploadUrlResponse;
			for (const [index, uploadFile] of files.entries()) {
				const signedFile = body.upload.files[index];
				if (!signedFile) {
					throw new Error("上传签名数量与文件数量不一致");
				}
				const uploadResponse = await fetch(signedFile.uploadUrl, {
					method: signedFile.method,
					headers: signedFile.headers,
					// 文件内容直接写入 R2，避免 Worker 接管上传 body。
					body: uploadFile.file,
				});
				if (!uploadResponse.ok) {
					throw new Error(`上传 ${uploadFile.relativePath} 失败`);
				}
			}
			setUploadTarget(null);
			await loadWorkspaceTree(project.id, uploadTarget.parentPath);
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : "上传失败");
			throw err;
		} finally {
			setIsWorkspaceMutating(false);
		}
	}

	/**
	 * 提交新建文件夹。
	 */
	async function createWorkspaceDirectory() {
		if (!project || !createDirectoryTarget) {
			return;
		}
		const nextName = createDirectoryValue.trim();
		if (!nextName || nextName.includes("/")) {
			return;
		}
		const path = buildChildDirectoryPath(createDirectoryTarget.parentPath, nextName);
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		try {
			const response = await fetch(`/api/projects/${project.id}/workspace/directory`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path }),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			setCreateDirectoryTarget(null);
			await loadWorkspaceTree(project.id, createDirectoryTarget.parentPath);
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : "新建文件夹失败");
		} finally {
			setIsWorkspaceMutating(false);
		}
	}

	/**
	 * 提交 workspace 重命名。
	 */
	async function renameWorkspaceItem() {
		if (!project || !renamingTarget) {
			return;
		}
		const nextName = renameValue.trim();
		if (!nextName || nextName === renamingTarget.name || nextName.includes("/")) {
			return;
		}
		const nextPath = buildRenamedPath(renamingTarget.path, nextName);
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		try {
			const response = await fetch(`/api/projects/${project.id}/workspace/move`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					fromPath: renamingTarget.path,
					toPath: nextPath,
				}),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			setOpenFileTabs((current) =>
				current.map((tab) => {
					if (!isPathOrChild(tab.path, renamingTarget.path)) {
						return tab;
					}
					const suffix = tab.path.slice(renamingTarget.path.length);
					return {
						path: `${nextPath}${suffix}`,
						name: tab.path === renamingTarget.path ? nextName : tab.name,
					};
				}),
			);
			if (activeFilePath && isPathOrChild(activeFilePath, renamingTarget.path)) {
				const suffix = activeFilePath.slice(renamingTarget.path.length);
				setActiveFilePath(`${nextPath}${suffix}`);
			}
			setRenamingTarget(null);
			await refreshWorkspaceTree();
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : "重命名失败");
		} finally {
			setIsWorkspaceMutating(false);
		}
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
		// 切换历史会话时主动定位到底部，后续由用户滚动状态决定是否继续跟随。
		forceStickToBottomRef.current = true;
		shouldStickToBottomRef.current = true;
		setSession(body.session);
		setClientEvents(body.clientEvents ?? []);
		timelineIdsRef.current = new Set(body.timeline.map((event) => event.id));
		setTimeline(body.timeline);
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
				setClientEvents((current) => [...current, body.event as ClientEvent]);
			}
		} catch (err) {
			setPermissionError(err instanceof Error ? err.message : "权限响应提交失败");
		} finally {
			setIsPermissionSubmitting(false);
		}
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
		// 用户主动发送消息时，应立即恢复对本轮输出的底部跟随。
		forceStickToBottomRef.current = true;
		shouldStickToBottomRef.current = true;
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
		if (authSession.isPending || !authUserId) {
			if (!authSession.isPending) {
				bootstrappedUserIdRef.current = null;
				setIsBootstrapping(false);
			}
			return;
		}
		if (bootstrappedUserIdRef.current === authUserId) {
			return;
		}
		bootstrappedUserIdRef.current = authUserId;
		setIsBootstrapping(true);
		void (async () => {
			try {
				const loadedProjects = await loadProjects();
				const selectedProject =
					loadedProjects.find((item) => item.id === initialSearch.projectId) ??
					loadedProjects[0];
				const loadedSessions = await loadSessions(selectedProject?.id);
				if (selectedProject) {
					setProject(selectedProject);
					setWorkspaceItems(createEmptyWorkspaceTree());
					setHasLoadedWorkspaceTree(false);
					// 初始化选定 project 后加载根目录；后续目录展开仍按需加载子目录。
					await loadWorkspaceTree(selectedProject.id);
				}
				if (initialSearch.sessionId) {
					await loadSession(initialSearch.sessionId);
				} else if (!initialSearch.projectId && loadedSessions[0]) {
					await loadSession(loadedSessions[0].id);
				} else {
					resetConversation();
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsBootstrapping(false);
			}
		})();
		return () => closeTimelineStream();
		// 初始化按 userId 去重；loader 使用当前闭包避免重复选择首个会话。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [authSession.isPending, authUserId]);

	useEffect(() => {
		if (isBootstrapping || authSession.isPending || !authUserId) {
			return;
		}
		void loadSessions(project?.id).catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
		});
	}, [project?.id, isBootstrapping, authSession.isPending, authUserId]);

	useEffect(() => {
		if (!forceStickToBottomRef.current && !shouldStickToBottomRef.current) {
			return;
		}
		scrollChatToBottom();
		forceStickToBottomRef.current = false;
	}, [messages.length, isSending, scrollChatToBottom]);

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
		<main className="h-dvh overflow-hidden bg-background text-foreground">
			<ResizablePanelGroup orientation="horizontal" className="h-full">
				<ResizablePanel
					defaultSize={hasPreviewPanel ? 33 : 50}
					minSize={22}
					maxSize={45}
					className="min-w-72"
				>
					<section className="flex h-full min-h-0 flex-col border-r bg-muted/20">
						<header className="flex shrink-0 flex-col gap-3 border-b p-4">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<h1 className="truncate text-base font-semibold">Neo Noumi Chat</h1>
									<p className="truncate text-sm text-muted-foreground">
										{project?.name ?? "默认工作区"}
									</p>
								</div>
								<Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
									首页
								</Link>
							</div>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button variant="outline" className="w-full justify-between" />
									}
								>
									<span className="truncate">{project?.name ?? "选择工作区"}</span>
									<ChevronDownIcon data-icon="inline-end" />
								</DropdownMenuTrigger>
								<DropdownMenuContent className="w-72">
									<DropdownMenuGroup>
										<DropdownMenuLabel>工作区</DropdownMenuLabel>
										{projects.map((item) => (
											<DropdownMenuItem
												key={item.id}
												onClick={() => selectProject(item)}
											>
												<span className="truncate">{item.name}</span>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						</header>

						<div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
							<p className="text-sm font-medium">工作区文件</p>
							<div className="flex items-center gap-2">
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="outline"
												size="sm"
												disabled={!project || isWorkspaceMutating}
											/>
										}
									>
										<FileUpIcon data-icon="inline-start" />
										上传
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											disabled={!project || isWorkspaceMutating}
											onClick={() => openUploadDialog("files")}
										>
											<FileUpIcon />
											上传文件
										</DropdownMenuItem>
										<DropdownMenuItem
											disabled={!project || isWorkspaceMutating}
											onClick={() => openUploadDialog("directory")}
										>
											<FolderUpIcon />
											上传文件夹
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
								<Button
									variant="outline"
									size="sm"
									disabled={!project || isWorkspaceLoading}
									onClick={() => void refreshWorkspaceTree()}
								>
									<RefreshCwIcon
										data-icon="inline-start"
										className={cn(isWorkspaceLoading && "animate-spin")}
									/>
									刷新
								</Button>
							</div>
						</div>

							<ContextMenu>
								<ContextMenuTrigger className="min-h-0 flex-1">
									<ScrollArea className="h-full">
										<div className="flex min-h-full flex-col gap-3 p-3">
								{workspaceError ? (
									<Alert variant="destructive">
										<AlertTitle>文件树加载失败</AlertTitle>
										<AlertDescription>{workspaceError}</AlertDescription>
									</Alert>
								) : null}
								{truncatedWorkspaceItems.length > 0 ? (
									<Alert>
										<AlertTitle>当前目录只显示第一批结果</AlertTitle>
										<AlertDescription>
											文件树按所选目录读取一层文件和文件夹，不递归拉取完整子树；如文件较多，请展开更具体的目录。
										</AlertDescription>
									</Alert>
								) : null}
								{isWorkspaceLoading && workspaceItems[WORKSPACE_ROOT_ID]?.children?.length === 0 ? (
									<div className="flex flex-col gap-2">
										<Skeleton className="h-8" />
										<Skeleton className="h-8" />
										<Skeleton className="h-8" />
									</div>
								) : null}
								<Tree tree={workspaceTree} indent={WORKSPACE_TREE_INDENT} className="gap-0.5">
									<AssistiveTreeDescription tree={workspaceTree} />
									{workspaceTree
										.getItems()
										.filter((item) => item.getId() !== WORKSPACE_ROOT_ID)
										.map((item) => {
											const data = item.getItemData();
											if (!data) {
												return null;
											}
											const isActive = activeFilePath === data.path;
											return (
												<ContextMenu key={item.getId()}>
													<ContextMenuTrigger className="block">
														<TreeItem item={item} className="w-full">
															<TreeItemLabel
																className={cn(
																	"w-full justify-start rounded-md bg-transparent",
																	isActive && "bg-accent text-accent-foreground",
																)}
																onClick={(event) => {
																	event.preventDefault();
																	event.stopPropagation();
																	if (data.type === "directory") {
																		if (item.isExpanded()) {
																			item.collapse();
																		} else {
																			item.expand();
																		}
																	}
																	void selectWorkspaceItem(data);
																}}
															>
																{data.type === "directory" ? (
																	<FolderIcon className="text-muted-foreground" />
																) : (
																	<FileIcon className="text-muted-foreground" />
																)}
																<span className="truncate">{data.name}</span>
															</TreeItemLabel>
														</TreeItem>
													</ContextMenuTrigger>
													<ContextMenuContent>
														<ContextMenuGroup>
															<ContextMenuItem onClick={() => openRenameDialog(data)}>
																<Edit3Icon />
																重命名
															</ContextMenuItem>
															{data.type === "directory" ? (
																<>
																	<ContextMenuItem
																		onClick={() => openCreateDirectoryDialog(data)}
																	>
																		<FolderPlusIcon />
																		新建文件夹
																	</ContextMenuItem>
																	<ContextMenuItem
																		disabled={!project || isWorkspaceMutating}
																		onClick={() => openUploadDialog("files", data)}
																	>
																		<FileUpIcon />
																		上传文件
																	</ContextMenuItem>
																	<ContextMenuItem
																		disabled={!project || isWorkspaceMutating}
																		onClick={() => openUploadDialog("directory", data)}
																	>
																		<FolderUpIcon />
																		上传文件夹
																	</ContextMenuItem>
																</>
															) : null}
															<ContextMenuItem
																variant="destructive"
																disabled={isWorkspaceMutating}
																onClick={() => void deleteWorkspaceItem(data)}
															>
																<Trash2Icon />
																删除
															</ContextMenuItem>
														</ContextMenuGroup>
													</ContextMenuContent>
												</ContextMenu>
											);
										})}
									</Tree>
									{!isWorkspaceLoading &&
									!workspaceError &&
									workspaceItems[WORKSPACE_ROOT_ID]?.children?.length === 0 ? (
										<div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
											{hasLoadedWorkspaceTree
												? "当前工作区还没有文件。"
												: "点击刷新加载工作区文件。"}
										</div>
									) : null}
										</div>
									</ScrollArea>
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuGroup>
										<ContextMenuItem
											disabled={!project || isWorkspaceMutating}
											onClick={() => openCreateDirectoryDialog()}
										>
											<FolderPlusIcon />
											新建文件夹
										</ContextMenuItem>
										<ContextMenuItem
											disabled={!project || isWorkspaceMutating}
											onClick={() => openUploadDialog("files")}
										>
											<FileUpIcon />
											上传文件
										</ContextMenuItem>
										<ContextMenuItem
											disabled={!project || isWorkspaceMutating}
											onClick={() => openUploadDialog("directory")}
										>
											<FolderUpIcon />
											上传文件夹
										</ContextMenuItem>
									</ContextMenuGroup>
								</ContextMenuContent>
							</ContextMenu>
					</section>
				</ResizablePanel>

				<ResizableHandle withHandle />

				{hasPreviewPanel ? (
					<>
						<ResizablePanel
							defaultSize={34}
							minSize={24}
							maxSize={50}
							className="min-w-80"
						>
							<section className="flex h-full min-h-0 flex-col border-r bg-background">
								<div className="flex shrink-0 items-end gap-1 overflow-x-auto border-b bg-muted/20 px-3 pt-3">
									{openFileTabs.map((tab) => (
										<button
											key={tab.path}
											type="button"
											className={cn(
												"flex h-9 max-w-56 min-w-32 items-center gap-2 rounded-t-md border px-3 text-sm",
												activeFilePath === tab.path
													? "border-b-background bg-background"
													: "bg-muted text-muted-foreground hover:bg-background",
											)}
											onClick={() => setActiveFilePath(tab.path)}
										>
											<span className="truncate">{tab.name}</span>
											<XIcon
												className="shrink-0"
												onClick={(event) => {
													event.stopPropagation();
													closeFileTab(tab.path);
												}}
											/>
										</button>
									))}
								</div>
								<div className="flex min-h-0 flex-1 items-center justify-center p-6">
									<div className="flex max-w-sm flex-col items-center gap-3 text-center">
										<div className="flex size-12 items-center justify-center rounded-full bg-muted">
											<FileIcon className="text-muted-foreground" />
										</div>
										<div className="flex flex-col gap-1">
											<h2 className="break-all text-base font-semibold">
												{activeFileTab?.name}
											</h2>
											<p className="break-all text-xs text-muted-foreground">
												{activeFileTab?.path}
											</p>
										</div>
										<p className="text-sm text-muted-foreground">
											文件预览能力待接入，当前仅保留选中文件占位。
										</p>
									</div>
								</div>
							</section>
						</ResizablePanel>
						<ResizableHandle withHandle />
					</>
				) : null}

				<ResizablePanel
					defaultSize={hasPreviewPanel ? 33 : 50}
					minSize={30}
					maxSize={60}
					className="min-w-96"
				>
					<section className="flex h-full min-h-0 min-w-0 flex-col">
						<header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													className="min-w-0 max-w-full justify-start px-1"
												/>
											}
										>
											<span className="truncate text-base font-semibold">
												{latestSessionTitle}
											</span>
											<ChevronDownIcon data-icon="inline-end" />
										</DropdownMenuTrigger>
										<DropdownMenuContent className="w-80">
											<DropdownMenuGroup>
												<DropdownMenuLabel>当前项目会话</DropdownMenuLabel>
												{sessions.length === 0 ? (
													<DropdownMenuItem disabled>暂无历史对话</DropdownMenuItem>
												) : (
													sessions.map((item) => (
														<DropdownMenuItem
															key={item.id}
															onClick={() => void loadSession(item.id)}
														>
															<div className="flex min-w-0 flex-col">
																<span className="truncate">
																	{item.title || DEFAULT_SESSION_TITLE}
																</span>
																<span className="flex items-center gap-1 text-xs text-muted-foreground">
																	<ClockIcon />
																	{new Date(item.updatedAt).toLocaleDateString()}
																</span>
															</div>
														</DropdownMenuItem>
													))
												)}
											</DropdownMenuGroup>
											<DropdownMenuSeparator />
											<DropdownMenuItem onClick={startNewConversation}>
												<MessageSquarePlusIcon />
												新对话
											</DropdownMenuItem>
											{session ? (
												<DropdownMenuItem
													variant="destructive"
													onClick={() => void deleteSession(session.id)}
												>
													<Trash2Icon />
													删除当前会话
												</DropdownMenuItem>
											) : null}
										</DropdownMenuContent>
									</DropdownMenu>
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
							<div className="flex shrink-0 items-center gap-2">
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

						<ScrollArea
							className="min-h-0 flex-1"
							viewportRef={chatViewportRef}
							onViewportScroll={updateChatStickState}
						>
							<div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
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
						</ScrollArea>

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
				</ResizablePanel>
			</ResizablePanelGroup>

			<Dialog open={Boolean(pendingPermissionRequest)} onOpenChange={() => undefined}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>允许 Claude Code 调用工具？</DialogTitle>
						<DialogDescription>
							{pendingPermissionRequest?.toolName ?? "unknown"}
						</DialogDescription>
					</DialogHeader>
					{permissionError ? (
						<Alert variant="destructive">
							<AlertTitle>提交失败</AlertTitle>
							<AlertDescription>{permissionError}</AlertDescription>
						</Alert>
					) : null}
					<div className="grid gap-2">
						<div className="flex items-center justify-between gap-3 text-sm">
							<span className="text-muted-foreground">Tool Use ID</span>
							<span className="truncate font-mono">
								{pendingPermissionRequest?.toolUseId || "-"}
							</span>
						</div>
						<pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
							{JSON.stringify(pendingPermissionRequest?.input ?? {}, null, 2)}
						</pre>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={isPermissionSubmitting || !pendingPermissionRequest}
							onClick={() => {
								if (pendingPermissionRequest) {
									void submitToolPermissionDecision(pendingPermissionRequest, "deny");
								}
							}}
						>
							拒绝
						</Button>
						<Button
							disabled={isPermissionSubmitting || !pendingPermissionRequest}
							onClick={() => {
								if (pendingPermissionRequest) {
									void submitToolPermissionDecision(pendingPermissionRequest, "allow");
								}
							}}
						>
							{isPermissionSubmitting ? (
								<Loader2Icon data-icon="inline-start" className="animate-spin" />
							) : (
								<CheckCircle2Icon data-icon="inline-start" />
							)}
							允许
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(renamingTarget)}
				onOpenChange={(open) => {
					if (!open) {
						setRenamingTarget(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>重命名</DialogTitle>
						<DialogDescription>
							请输入新的{renamingTarget?.type === "directory" ? "目录" : "文件"}名称。
						</DialogDescription>
					</DialogHeader>
					<Input
						value={renameValue}
						disabled={isWorkspaceMutating}
						onChange={(event) => setRenameValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void renameWorkspaceItem();
							}
						}}
					/>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={isWorkspaceMutating}
							onClick={() => setRenamingTarget(null)}
						>
							取消
						</Button>
						<Button
							disabled={
								isWorkspaceMutating ||
								!renameValue.trim() ||
								renameValue.trim() === renamingTarget?.name ||
								renameValue.includes("/")
							}
							onClick={() => void renameWorkspaceItem()}
						>
							{isWorkspaceMutating ? (
								<Loader2Icon data-icon="inline-start" className="animate-spin" />
							) : null}
							保存
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(createDirectoryTarget)}
				onOpenChange={(open) => {
					if (!open) {
						setCreateDirectoryTarget(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>新建文件夹</DialogTitle>
						<DialogDescription>
							将在 {createDirectoryTarget?.parentName ?? "根目录"} 下创建新文件夹。
						</DialogDescription>
					</DialogHeader>
					<Input
						value={createDirectoryValue}
						disabled={isWorkspaceMutating}
						onChange={(event) => setCreateDirectoryValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void createWorkspaceDirectory();
							}
						}}
					/>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={isWorkspaceMutating}
							onClick={() => setCreateDirectoryTarget(null)}
						>
							取消
						</Button>
						<Button
							disabled={
								isWorkspaceMutating ||
								!createDirectoryValue.trim() ||
								createDirectoryValue.includes("/")
							}
							onClick={() => void createWorkspaceDirectory()}
						>
							{isWorkspaceMutating ? (
								<Loader2Icon data-icon="inline-start" className="animate-spin" />
							) : null}
							创建
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(uploadTarget)}
				onOpenChange={(open) => {
					if (!open) {
						setUploadTarget(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{uploadTarget?.mode === "directory" ? "上传文件夹" : "上传文件"}
						</DialogTitle>
						<DialogDescription>
							将内容上传到 {uploadTarget?.parentName ?? "根目录"}；同名文件会被新上传内容覆盖。
						</DialogDescription>
					</DialogHeader>
					{uploadTarget ? (
						<WorkspaceUploadPanel
							mode={uploadTarget.mode}
							targetName={uploadTarget.parentName}
							disabled={isWorkspaceMutating}
							onUpload={uploadWorkspaceFiles}
						/>
					) : null}
				</DialogContent>
			</Dialog>
		</main>
	);
}

/** 默认折叠展示的运行事件类型。 */
const DEFAULT_COLLAPSED_TOOL_META_TYPES = [
	"system",
	"result",
	"thinking",
	"tool_use",
	"bash_progress",
	"control_request",
	"control_response",
];

/**
 * payload.data.type 默认气泡组件。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
function GenericPayloadDataMessageBubble({ message }: PayloadDataBubbleRendererProps) {
	return <DefaultMessageBubble message={message} />;
}

/**
 * 单条聊天消息分发器。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
function MessageBubble({ message }: { message: ChatMessage }) {
	if (message.payloadDataType && isTimelineMessageChunk(message.chunk)) {
		const payloadDataBubbleProps = {
			message,
			chunk: message.chunk,
			payloadDataType: message.payloadDataType,
		};
		switch (message.payloadDataType) {
			case "bash_progress":
				// 先显式保留分支；后续 bash_progress 可替换成独立组件。
				return <GenericPayloadDataMessageBubble {...payloadDataBubbleProps} />;
			default:
				// 未单独适配的 payload.data.type 暂时复用通用气泡。
				return <GenericPayloadDataMessageBubble {...payloadDataBubbleProps} />;
		}
	}
	return <DefaultMessageBubble message={message} />;
}

/**
 * 默认聊天消息气泡。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
function DefaultMessageBubble({ message }: { message: ChatMessage }) {
	const isUser = message.role === "user";
	const isTool = message.role === "tool";
	const isThinking = message.meta === "thinking";
	const isToolUse = message.meta === "tool_use";
	const isControlEvent =
		message.meta === "control_request" || message.meta === "control_response";
	const isCollapsedRawEvent =
		isTool &&
		DEFAULT_COLLAPSED_TOOL_META_TYPES.includes(message.meta ?? "");
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
								: isControlEvent
									? getControlEventSummary(message.raw, message.meta)
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
