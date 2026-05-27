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
	PauseCircleIcon,
	RefreshCwIcon,
	SendIcon,
	SquareIcon,
	Trash2Icon,
	WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import {
	DEFAULT_SESSION_TITLE,
	type ChatSearch,
	type Project,
	useChatSessions,
} from "@/hooks/use-chat-sessions";
import {
	type ChatPermissionMode,
	useChatBusiness,
} from "@/hooks/use-chat-business";
import { readError } from "@/lib/api-error";
import {
	addOptimisticWorkspaceDirectory,
	buildChildDirectoryPath,
	buildMovedIntoDirectoryPath,
	buildRenamedPath,
	type CreateDirectoryTarget,
	createEmptyWorkspaceTree,
	createWorkspaceTreeFallbackItem,
	getWorkspaceParentPath,
	isPathOrChild,
	moveOptimisticWorkspaceItem,
	type OpenFileTab,
	removeOptimisticWorkspaceItem,
	type RenameTarget,
	type UploadTarget,
	WORKSPACE_ROOT_ID,
	WORKSPACE_TREE_INDENT,
	type WorkspaceTreeItem,
	type WorkspaceTreeResponse,
	type WorkspaceUploadUrlResponse,
	workspaceNodeToTreeItem,
} from "@/lib/workspace-model";

/** 空输入占位文案。 */
const MESSAGE_PLACEHOLDER = "描述你想完成的任务，或者粘贴错误、需求、代码片段。";

/** 判断 chat 是否仍贴近底部的像素阈值。 */
const CHAT_BOTTOM_STICK_THRESHOLD = 48;

/** 触顶加载更早历史的像素阈值。 */
const CHAT_HISTORY_TOP_THRESHOLD = 24;

/** Chat 输入区可选的权限模式。 */
const CHAT_PERMISSION_MODE_OPTIONS: Array<{
	/** Claude Code control_request 使用的模式值。 */
	value: ChatPermissionMode;
	/** UI 展示名称。 */
	label: string;
}> = [
	{ value: "default", label: "Default" },
	{ value: "plan", label: "Plan" },
	{ value: "acceptEdits", label: "Accept edits" },
	{ value: "bypassPermissions", label: "Bypass permissions" },
	{ value: "dontAsk", label: "Don't ask" },
];

/** Chat 输入区可选的模型。 */
const CHAT_MODEL_OPTIONS = ["sonnet", "opus", "default"] as const;

/**
 * 判断 metadata 中的权限模式是否可由当前页面控制。
 * @param value metadata 字段值
 * @returns 是否为已知权限模式
 */
function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
	return CHAT_PERMISSION_MODE_OPTIONS.some((option) => option.value === value);
}

/**
 * 读取权限模式展示名称。
 * @param mode 权限模式
 * @returns 展示名称
 */
function getPermissionModeLabel(mode: string): string {
	return (
		CHAT_PERMISSION_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
	);
}

/**
 * 判断模型是否在当前页面的预设选项里。
 * @param model 模型名
 * @returns 是否为预设模型
 */
function isChatModelOption(
	model: string,
): model is (typeof CHAT_MODEL_OPTIONS)[number] {
	return CHAT_MODEL_OPTIONS.includes(model as (typeof CHAT_MODEL_OPTIONS)[number]);
}

/**
 * 读取会话 metadata 中的字符串字段。
 * @param metadata 会话 metadata
 * @param key 字段名
 * @returns 字符串字段
 */
function readMetadataString(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" ? value : undefined;
}

export const Route = createFileRoute("/chat")({
	validateSearch: (search): ChatSearch => ({
		projectId: typeof search.projectId === "string" ? search.projectId : undefined,
		sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
	}),
	component: ChatPage,
});

/**
 * 产品化 Chat 页面。
 * @returns Chat 页面组件
 */
function ChatPage() {
	const authSession = authClient.useSession();
	const initialSearch = Route.useSearch();
	const navigate = useNavigate();
	const bootstrappedUserIdRef = useRef<string | null>(null);
	const chatViewportRef = useRef<HTMLDivElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const forceStickToBottomRef = useRef(false);
	const [projects, setProjects] = useState<Project[]>([]);
	const [project, setProject] = useState<Project | null>(null);
	const [chatNotFoundMessage, setChatNotFoundMessage] = useState<string | null>(null);
	const [isBootstrapping, setIsBootstrapping] = useState(true);
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
	const [permissionMode, setPermissionMode] = useState<string>("default");
	const [chatModel, setChatModel] = useState("sonnet");

	/**
	 * 同步 chat 页面 URL 查询参数。
	 * @param search 下一份查询参数
	 * @param replace 是否替换当前 history 记录
	 */
	const updateChatRouteSearch = useCallback((search: ChatSearch, replace = false) => {
		void navigate({
			to: "/chat",
			search,
			replace,
		});
	}, [navigate]);

	const {
		callContainer,
		containerStatus,
		deleteSession: deleteChatSession,
		isLoadingHistory,
		loadSession: loadChatSession,
		loadSessions,
		resetConversation: resetSessionConversation,
		session,
		sessionError,
		sessions,
		startNewConversation: startSessionConversation,
		loadOlderSessionHistory,
		...chatSessionState
	} = useChatSessions({
		onRequestScrollToBottom: () => {
			forceStickToBottomRef.current = true;
			shouldStickToBottomRef.current = true;
		},
		project,
		setProject,
		updateChatRouteSearch,
	});
	const {
		closeTimelineStream,
		draft,
		error,
		isPermissionSubmitting,
		isSending,
		isStopping,
		messages,
		pendingPermissionRequest,
		permissionError,
		resetChatRuntime,
		running,
		sendMessage,
		setDraft,
		setError,
		stopMessage,
		submitToolPermissionDecision,
	} = useChatBusiness({
		...chatSessionState,
		getControlOptions: () => {
			const controlMode = isChatPermissionMode(permissionMode)
				? permissionMode
				: undefined;
			return {
				...(controlMode
					? {
							permissionMode: controlMode,
							ultraplan: controlMode === "plan",
						}
					: {}),
				model: chatModel,
			};
		},
		loadSessions,
		onRequestScrollToBottom: () => {
			forceStickToBottomRef.current = true;
			shouldStickToBottomRef.current = true;
		},
		session,
	});
	const latestSessionTitle = session?.title || DEFAULT_SESSION_TITLE;
	const displayError = error ?? sessionError;
	const sessionPermissionMode = readMetadataString(
		session?.externalMetadata,
		"permission_mode",
	);
	const sessionModel = readMetadataString(session?.externalMetadata, "model");
	const taskSummary = readMetadataString(session?.externalMetadata, "task_summary");
	const permissionModeLabel = getPermissionModeLabel(permissionMode);
	const permissionModeOptions = isChatPermissionMode(permissionMode)
		? CHAT_PERMISSION_MODE_OPTIONS
		: [
				{ value: permissionMode, label: permissionMode },
				...CHAT_PERMISSION_MODE_OPTIONS,
			];
	const chatModelOptions = isChatModelOption(chatModel)
		? CHAT_MODEL_OPTIONS
		: ([chatModel, ...CHAT_MODEL_OPTIONS] as const);

	useEffect(() => {
		if (sessionPermissionMode) {
			// metadata 是 worker/route 的真实状态来源；即使未来新增模式，UI 也要先保留并展示。
			setPermissionMode(sessionPermissionMode);
		}
		if (sessionModel) {
			// Claude Code 的 set_model 接受任意字符串，不能因为不在预设里就丢掉真实模型名。
			setChatModel(sessionModel);
		}
	}, [sessionModel, sessionPermissionMode]);

	useEffect(() => {
		setOpenFileTabs((current) =>
			current.map((tab) => {
				const item = workspaceItems[tab.path];
				if (!item || item.type !== "file") {
					return tab;
				}
				// 文件树刷新后同步 etag，确保预览 URL 只在文件版本变化时更新。
				return item.etag === tab.etag && item.name === tab.name
					? tab
					: { ...tab, etag: item.etag, name: item.name };
			}),
		);
	}, [workspaceItems]);

	/**
	 * 重置完整对话上下文。
	 */
	function resetConversation() {
		closeTimelineStream();
		resetChatRuntime();
		resetSessionConversation();
	}

	/**
	 * 加载会话前先结束旧 stream，避免旧 session 的增量继续写入当前页面。
	 * @param sessionId session ID
	 * @param options 加载选项
	 * @returns 已加载的 session
	 */
	async function loadSession(
		sessionId: string,
		options: { syncRoute?: boolean } = {},
	) {
		closeTimelineStream();
		return loadChatSession(sessionId, options);
	}

	/**
	 * 创建新的空白对话。
	 */
	function startNewConversation() {
		closeTimelineStream();
		resetChatRuntime();
		startSessionConversation();
		setDraft("");
		setError(null);
	}

	/**
	 * 删除指定会话。
	 * @param sessionId session ID
	 */
	async function deleteSession(sessionId: string) {
		if (session?.id === sessionId) {
			closeTimelineStream();
			resetChatRuntime();
		}
		try {
			await deleteChatSession(sessionId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const workspaceTree = useTree<WorkspaceTreeItem>({
		dataLoader: {
			getChildren: (itemId) => workspaceItems[itemId]?.children ?? [],
			getItem: (itemId) =>
				workspaceItems[itemId] ?? createWorkspaceTreeFallbackItem(itemId),
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

	const activeFileTab = openFileTabs.find((tab) => tab.path === activeFilePath) ?? null;
	const hasPreviewPanel = Boolean(activeFileTab);
	const authUserId = authSession.data?.user.id;
	const truncatedWorkspaceItems = Object.values(workspaceItems).filter(
		(item) => item.type === "directory" && item.isTruncated,
	);

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
	async function handleChatViewportScroll() {
		updateChatStickState();
		const viewport = chatViewportRef.current;
		if (!viewport || viewport.scrollTop > CHAT_HISTORY_TOP_THRESHOLD) {
			return;
		}
		const previousScrollHeight = viewport.scrollHeight;
		const previousScrollTop = viewport.scrollTop;
		await loadOlderSessionHistory();
		requestAnimationFrame(() => {
			const nextViewport = chatViewportRef.current;
			if (!nextViewport) {
				return;
			}
			// prepend 历史后补偿高度差，避免用户视角跳到更早内容顶部。
			nextViewport.scrollTop =
				nextViewport.scrollHeight - previousScrollHeight + previousScrollTop;
		});
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
	 * 加载指定目录下的 workspace 文件树节点。
	 * @param projectId 项目 ID
	 * @param prefix workspace 目录路径
	 * @param options 加载选项
	 */
	async function loadWorkspaceTree(
		projectId: string,
		prefix = "",
		options: { clearError?: boolean; showLoading?: boolean } = {},
	) {
		const clearError = options.clearError ?? true;
		const showLoading = options.showLoading ?? true;
		if (clearError) {
			setWorkspaceError(null);
		}
		if (showLoading) {
			setIsWorkspaceLoading(true);
		}
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
				// Headless Tree 会缓存展开节点；刷新根目录时也保留旧 item，避免同步读取到 undefined。
				const nextItems = { ...current };
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
					...(nextItems[parentId] ?? createWorkspaceTreeFallbackItem(parentId)),
					path: prefix,
					type: "directory",
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
			if (showLoading) {
				setIsWorkspaceLoading(false);
			}
		}
	}

	/**
	 * 刷新当前 project 的 workspace 文件树。
	 * @param prefixes 指定要刷新的目录；省略时刷新所有已加载目录
	 */
	async function refreshWorkspaceTree(prefixes?: string[]) {
		if (!project) {
			return;
		}
		const loadedPrefixes = Object.values(workspaceItems)
			.filter((item) => item.type === "directory" && item.isLoaded)
			.map((item) => item.path);
		const refreshPrefixes = Array.from(new Set(prefixes ?? loadedPrefixes));
		if (!refreshPrefixes.includes("")) {
			// 根目录是文件树入口，刷新任意子目录前都保持根目录 children 与 R2 对齐。
			refreshPrefixes.unshift("");
		}
		setIsWorkspaceLoading(true);
		setWorkspaceError(null);
		try {
			for (const prefix of refreshPrefixes) {
				await loadWorkspaceTree(project.id, prefix, {
					clearError: false,
					showLoading: false,
				});
			}
		} finally {
			setIsWorkspaceLoading(false);
		}
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
				: [
						...current,
						{
							path: item.path,
							name: item.name,
							etag: item.etag,
							mode: "preview",
						},
					];
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
	 * 切换文件标签的功能模式。
	 * @param path 文件路径
	 * @param mode 目标模式
	 */
	function changeFileTabMode(path: string, mode: OpenFileTab["mode"]) {
		setOpenFileTabs((current) =>
			current.map((tab) => (tab.path === path ? { ...tab, mode } : tab)),
		);
	}

	/**
	 * 文件保存后刷新所在目录的 workspace 元数据。
	 * @param path 文件路径
	 */
	async function handleWorkspaceFileSaved(path: string) {
		await refreshWorkspaceTree([getWorkspaceParentPath(path)]);
	}

	/**
	 * 删除 workspace 文件或目录。
	 * @param item 文件树数据项
	 */
	async function deleteWorkspaceItem(item: WorkspaceTreeItem) {
		if (!project || item.path === "") {
			return;
		}
		const previousWorkspaceItems = workspaceItems;
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		setWorkspaceItems((current) => removeOptimisticWorkspaceItem(current, item.path));
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
			await refreshWorkspaceTree([getWorkspaceParentPath(item.path)]);
		} catch (err) {
			setWorkspaceItems(previousWorkspaceItems);
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
		const previousWorkspaceItems = workspaceItems;
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		setWorkspaceItems((current) => addOptimisticWorkspaceDirectory(current, path));
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
			setWorkspaceItems(previousWorkspaceItems);
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
		const previousWorkspaceItems = workspaceItems;
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		setWorkspaceItems((current) =>
			moveOptimisticWorkspaceItem(current, renamingTarget.path, nextPath),
		);
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
						...tab,
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
			await refreshWorkspaceTree([
				getWorkspaceParentPath(renamingTarget.path),
				getWorkspaceParentPath(nextPath),
			]);
		} catch (err) {
			setWorkspaceItems(previousWorkspaceItems);
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
		const previousWorkspaceItems = workspaceItems;
		setIsWorkspaceMutating(true);
		setWorkspaceError(null);
		setWorkspaceItems((current) =>
			moveOptimisticWorkspaceItem(current, source.path, nextPath),
		);
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
						...tab,
						path: `${nextPath}${suffix}`,
						name: tab.path === source.path ? source.name : tab.name,
					};
				}),
			);
			if (activeFilePath && isPathOrChild(activeFilePath, source.path)) {
				const suffix = activeFilePath.slice(source.path.length);
				setActiveFilePath(`${nextPath}${suffix}`);
			}
			await refreshWorkspaceTree([
				getWorkspaceParentPath(source.path),
				targetDirectory.path,
			]);
		} catch (err) {
			setWorkspaceItems(previousWorkspaceItems);
			setWorkspaceError(err instanceof Error ? err.message : "移动失败");
		} finally {
			setIsWorkspaceMutating(false);
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
	}, [
		project?.id,
		isBootstrapping,
		authSession.isPending,
		authUserId,
		loadSessions,
		setError,
	]);

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
					projectId={project?.id ?? null}
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
					onFileModeChange={changeFileTabMode}
					onFileSaved={handleWorkspaceFileSaved}
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
					defaultSize={hasPreviewPanel ? "49%" : "83%"}
					minSize={hasPreviewPanel ? "30%" : "75%"}
					maxSize={hasPreviewPanel ? "60%" : "86%"}
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
									{running ? (
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
									<Badge variant={permissionMode === "plan" ? "secondary" : "outline"}>
										{permissionMode === "plan" ? (
											<PauseCircleIcon data-icon="inline-start" />
										) : null}
										{permissionModeLabel}
									</Badge>
									<Badge variant="outline">{chatModel}</Badge>
								</div>
								<p className="truncate text-sm text-muted-foreground">
									{taskSummary || session?.id || "发送消息后会自动创建会话"}
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
									disabled={!session || !running || isStopping}
									onClick={() => void stopMessage()}
								>
									{isStopping ? (
										<Loader2Icon data-icon="inline-start" className="animate-spin" />
									) : (
										<SquareIcon data-icon="inline-start" />
									)}
									停止回复
								</Button>
							</div>
						</header>

						<ScrollArea
							className="min-h-0 flex-1"
							viewportRef={chatViewportRef}
							onViewportScroll={handleChatViewportScroll}
						>
							<div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
								{displayError ? (
									<Alert variant="destructive">
										<AlertTitle>操作失败</AlertTitle>
										<AlertDescription>{displayError}</AlertDescription>
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

								{running ? (
									<div className="flex items-center gap-3 text-sm text-muted-foreground">
										<Loader2Icon className="animate-spin" />
										{isStopping ? "正在停止回复..." : "正在等待回复..."}
									</div>
								) : null}
								<div ref={messagesEndRef} />
							</div>
						</ScrollArea>

						<footer className="shrink-0 border-t bg-background px-4 py-4">
							<div className="mx-auto flex max-w-4xl flex-col gap-3">
								<div className="rounded-xl border bg-card p-2 shadow-sm">
									<div className="flex flex-wrap items-center gap-2 px-1 pb-2">
										<Select
											value={permissionMode}
											onValueChange={(value) => {
												if (value) {
													setPermissionMode(value);
												}
											}}
											disabled={running}
										>
											<SelectTrigger size="sm" className="min-w-36">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													{permissionModeOptions.map((option) => (
														<SelectItem key={option.value} value={option.value}>
															{option.label}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
										<Select
											value={chatModel}
											onValueChange={(value) => {
												if (value) {
													setChatModel(value);
												}
											}}
											disabled={running}
										>
											<SelectTrigger size="sm" className="min-w-28">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													{chatModelOptions.map((model) => (
														<SelectItem key={model} value={model}>
															{model}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
										{permissionMode === "plan" ? (
											<Badge variant="secondary">
												<PauseCircleIcon data-icon="inline-start" />
												Plan mode
											</Badge>
										) : null}
									</div>
									<Textarea
										value={draft}
										disabled={running}
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
										<Button disabled={!draft.trim() || running} onClick={sendMessage}>
											{running ? (
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
