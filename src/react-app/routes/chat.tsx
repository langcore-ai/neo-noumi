import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	hotkeysCoreFeature,
	selectionFeature,
	syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
	BotIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClockIcon,
	Loader2Icon,
	MessageSquarePlusIcon,
	RefreshCwIcon,
	SendIcon,
	SquareIcon,
	Trash2Icon,
	WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageBubble } from "@/components/chat/message-bubble";
import { WorkspacePanel } from "@/components/chat/workspace-panel";
import WorkspaceUploadPanel, {
	type WorkspaceUploadFile,
} from "@/components/comp-549";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import {
	buildMessages,
	type ClientEvent,
	findPendingToolPermissionRequest,
	type TimelineEvent,
	type ToolPermissionRequest,
} from "@/lib/chat-message-model";
import {
	buildChildDirectoryPath,
	buildMovedIntoDirectoryPath,
	buildRenamedPath,
	type CreateDirectoryTarget,
	createEmptyWorkspaceTree,
	isPathOrChild,
	type OpenFileTab,
	type RenameTarget,
	type UploadTarget,
	WORKSPACE_ROOT_ID,
	WORKSPACE_TREE_INDENT,
	type WorkspaceTreeItem,
	type WorkspaceTreeResponse,
	type WorkspaceUploadUrlResponse,
	workspaceNodeToTreeItem,
} from "@/lib/workspace-model";

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

/** 默认会话标题，用户直接发送第一条消息时使用。 */
const DEFAULT_SESSION_TITLE = "新的对话";

/** 空输入占位文案。 */
const MESSAGE_PLACEHOLDER = "描述你想完成的任务，或者粘贴错误、需求、代码片段。";

/** 判断 chat 是否仍贴近底部的像素阈值。 */
const CHAT_BOTTOM_STICK_THRESHOLD = 48;

/** 触顶加载更早历史的像素阈值。 */
const CHAT_HISTORY_TOP_THRESHOLD = 24;

/** Chat 页面每次加载的历史事件数量。 */
const CHAT_HISTORY_PAGE_SIZE = 10;

/** 空历史分页状态。 */
const EMPTY_SESSION_HISTORY: SessionHistoryState = {
	hasMoreClientEvents: false,
	hasMoreTimeline: false,
	beforeClientSequence: null,
	beforeTimelineId: null,
};

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
	const navigate = useNavigate();
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
	const [sessionHistory, setSessionHistory] = useState<SessionHistoryState>(
		EMPTY_SESSION_HISTORY,
	);
	const [draft, setDraft] = useState("");
	const [containerStatus, setContainerStatus] = useState<unknown>(null);
	const [error, setError] = useState<string | null>(null);
	const [chatNotFoundMessage, setChatNotFoundMessage] = useState<string | null>(null);
	const [isBootstrapping, setIsBootstrapping] = useState(true);
	const [isSending, setIsSending] = useState(false);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);
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
	 * 同步 chat 页面 URL 查询参数。
	 * @param search 下一份查询参数
	 * @param replace 是否替换当前 history 记录
	 */
	function updateChatRouteSearch(search: ChatSearch, replace = false) {
		void navigate({
			to: "/chat",
			search,
			replace,
		});
	}

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
	 * 处理 chat viewport 滚动。
	 */
	function handleChatViewportScroll() {
		updateChatStickState();
		const viewport = chatViewportRef.current;
		if (!viewport || viewport.scrollTop > CHAT_HISTORY_TOP_THRESHOLD) {
			return;
		}
		void loadOlderSessionHistory();
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
		setSessionHistory(EMPTY_SESSION_HISTORY);
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
		updateChatRouteSearch({ projectId: nextProject.id });
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
					sourceType: renamingTarget.type,
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
	 * 将 workspace 节点移动到目标目录。
	 * @param source 被移动的节点
	 * @param targetDirectory 目标目录
	 */
	async function moveWorkspaceItemIntoDirectory(
		source: WorkspaceTreeItem,
		targetDirectory: WorkspaceTreeItem,
	) {
		if (!project || targetDirectory.type !== "directory") {
			return;
		}
		if (source.path === targetDirectory.path) {
			return;
		}
		if (source.type === "directory" && isPathOrChild(targetDirectory.path, source.path)) {
			setWorkspaceError("不能把目录移动到自身或其子目录下");
			return;
		}
		const nextPath = buildMovedIntoDirectoryPath(targetDirectory.path, source.name);
		if (nextPath === source.path) {
			return;
		}
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		try {
			const response = await fetch(`/api/projects/${project.id}/workspace/move`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					fromPath: source.path,
					toPath: nextPath,
					sourceType: source.type,
				}),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			setOpenFileTabs((current) =>
				current.map((tab) => {
					if (!isPathOrChild(tab.path, source.path)) {
						return tab;
					}
					const suffix = tab.path.slice(source.path.length);
					return {
						path: `${nextPath}${suffix}`,
						name: tab.path === source.path ? source.name : tab.name,
					};
				}),
			);
			if (activeFilePath && isPathOrChild(activeFilePath, source.path)) {
				const suffix = activeFilePath.slice(source.path.length);
				setActiveFilePath(`${nextPath}${suffix}`);
			}
			await refreshWorkspaceTree();
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : "移动失败");
		} finally {
			setIsWorkspaceMutating(false);
		}
	}

	/**
	 * 加载会话详情和历史消息。
	 * @param sessionId session ID
	 * @param options 加载选项
	 * @returns 已加载的 session
	 */
	async function loadSession(
		sessionId: string,
		options: { syncRoute?: boolean } = {},
	): Promise<ChatSession> {
		closeTimelineStream();
		const response = await fetch(
			`/api/ccr/sessions/${sessionId}?limit=${CHAT_HISTORY_PAGE_SIZE}`,
		);
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
		setSessionHistory(body.history ?? EMPTY_SESSION_HISTORY);
		if (options.syncRoute ?? true) {
			updateChatRouteSearch({
				projectId: body.session.projectId,
				sessionId: body.session.id,
			});
		}
		return body.session;
	}

	/**
	 * 向上滚动触顶时加载更早的会话历史。
	 */
	async function loadOlderSessionHistory() {
		if (
			!session ||
			isLoadingHistory ||
			(!sessionHistory.hasMoreClientEvents && !sessionHistory.hasMoreTimeline)
		) {
			return;
		}
		const viewport = chatViewportRef.current;
		const previousScrollHeight = viewport?.scrollHeight ?? 0;
		const previousScrollTop = viewport?.scrollTop ?? 0;
		const params = new URLSearchParams({
			older: "1",
			limit: String(CHAT_HISTORY_PAGE_SIZE),
		});
		if (sessionHistory.hasMoreClientEvents && sessionHistory.beforeClientSequence) {
			params.set(
				"beforeClientSequence",
				String(sessionHistory.beforeClientSequence),
			);
		}
		if (sessionHistory.hasMoreTimeline && sessionHistory.beforeTimelineId) {
			params.set("beforeTimelineId", String(sessionHistory.beforeTimelineId));
		}
		setIsLoadingHistory(true);
		setError(null);
		try {
			const response = await fetch(`/api/ccr/sessions/${session.id}?${params}`);
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as SessionDetailResponse;
			setClientEvents((current) => mergeClientEvents(body.clientEvents ?? [], current));
			setTimeline((current) => mergeTimelineEvents(body.timeline, current));
			setSessionHistory(body.history ?? EMPTY_SESSION_HISTORY);
			requestAnimationFrame(() => {
				const nextViewport = chatViewportRef.current;
				if (!nextViewport) {
					return;
				}
				// prepend 历史后补偿高度差，避免用户视角跳到更早内容顶部。
				nextViewport.scrollTop =
					nextViewport.scrollHeight - previousScrollHeight + previousScrollTop;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载历史消息失败");
		} finally {
			setIsLoadingHistory(false);
		}
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
		setSessionHistory(EMPTY_SESSION_HISTORY);
		updateChatRouteSearch({
			projectId: body.session.projectId,
			sessionId: body.session.id,
		});
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
		updateChatRouteSearch(project ? { projectId: project.id } : {});
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
				updateChatRouteSearch(project ? { projectId: project.id } : {});
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
				if (loadedProjects.length === 0) {
					setChatNotFoundMessage("未找到可用项目");
					window.setTimeout(() => {
						void navigate({ to: "/projects", replace: true });
					}, 800);
					return;
				}
				if (
					initialSearch.projectId &&
					!loadedProjects.some((item) => item.id === initialSearch.projectId) &&
					!initialSearch.sessionId
				) {
					setChatNotFoundMessage("项目不存在或已被删除");
					window.setTimeout(() => {
						void navigate({ to: "/projects", replace: true });
					}, 800);
					return;
				}
				const selectedProject =
					loadedProjects.find((item) => item.id === initialSearch.projectId) ??
					loadedProjects[0];
				if (initialSearch.sessionId) {
					const loadedSession = await loadSession(initialSearch.sessionId, {
						syncRoute: false,
					});
					const sessionProject =
						loadedProjects.find((item) => item.id === loadedSession.projectId) ??
						selectedProject;
					if (sessionProject) {
						setProject(sessionProject);
						setWorkspaceItems(createEmptyWorkspaceTree());
						setHasLoadedWorkspaceTree(false);
						await loadSessions(sessionProject.id);
						// sessionId 是更可信来源，projectId 不一致时用 session 所属项目修正 URL。
						await loadWorkspaceTree(sessionProject.id);
					}
					updateChatRouteSearch(
						{
							projectId: loadedSession.projectId,
							sessionId: loadedSession.id,
						},
						true,
					);
				} else if (selectedProject) {
					const loadedSessions = await loadSessions(selectedProject.id);
					setProject(selectedProject);
					setWorkspaceItems(createEmptyWorkspaceTree());
					setHasLoadedWorkspaceTree(false);
					// 初始化选定 project 后加载根目录；后续目录展开仍按需加载子目录。
					await loadWorkspaceTree(selectedProject.id);
					if (!initialSearch.projectId && loadedSessions[0]) {
						const loadedSession = await loadSession(loadedSessions[0].id, {
							syncRoute: false,
						});
						updateChatRouteSearch(
							{
								projectId: loadedSession.projectId,
								sessionId: loadedSession.id,
							},
							true,
						);
					} else {
						resetConversation();
						updateChatRouteSearch({ projectId: selectedProject.id }, true);
					}
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

	if (chatNotFoundMessage) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>404</CardTitle>
						<CardDescription>{chatNotFoundMessage}，正在跳转到项目页。</CardDescription>
					</CardHeader>
					<CardContent>
						<Link to="/projects" className={buttonVariants({ className: "w-full" })}>
							前往项目页
						</Link>
					</CardContent>
				</Card>
			</main>
		);
	}

	return (
		<main className="h-dvh overflow-hidden bg-background text-foreground">
			<ResizablePanelGroup orientation="horizontal" className="h-full">
				<WorkspacePanel
					projectName={project?.name ?? null}
					projects={projects}
					hasProject={Boolean(project)}
					workspaceTree={workspaceTree}
					workspaceItems={workspaceItems}
					workspaceError={workspaceError}
					hasLoadedWorkspaceTree={hasLoadedWorkspaceTree}
					isWorkspaceLoading={isWorkspaceLoading}
					isWorkspaceMutating={isWorkspaceMutating}
					truncatedWorkspaceItems={truncatedWorkspaceItems}
					openFileTabs={openFileTabs}
					activeFilePath={activeFilePath}
					activeFileTab={activeFileTab}
					hasPreviewPanel={hasPreviewPanel}
					onRefreshWorkspaceTree={() => void refreshWorkspaceTree()}
					onSelectWorkspaceItem={(item) => void selectWorkspaceItem(item)}
					onDeleteWorkspaceItem={(item) => void deleteWorkspaceItem(item)}
					onOpenRenameDialog={openRenameDialog}
					onOpenCreateDirectoryDialog={openCreateDirectoryDialog}
					onOpenUploadDialog={openUploadDialog}
					onCloseFileTab={closeFileTab}
					onSetActiveFilePath={setActiveFilePath}
					onSelectProject={selectProject}
					onMoveWorkspaceItemIntoDirectory={(source, targetDirectory) =>
						void moveWorkspaceItemIntoDirectory(source, targetDirectory)
					}
				/>

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
							onViewportScroll={handleChatViewportScroll}
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

								{isLoadingHistory ? (
									<div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
										<Loader2Icon className="animate-spin" />
										正在加载更早消息...
									</div>
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
