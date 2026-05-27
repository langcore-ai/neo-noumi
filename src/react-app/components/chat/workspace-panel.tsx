import { Link } from "@tanstack/react-router";
import type { useTree } from "@headless-tree/react";
import { AssistiveTreeDescription } from "@headless-tree/react";
import {
	ChevronDownIcon,
	Edit3Icon,
	FileIcon,
	FileUpIcon,
	FolderIcon,
	FolderPlusIcon,
	FolderUpIcon,
	RefreshCwIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import { Tree, TreeItem, TreeItemLabel } from "@/components/tree";
import { WorkspaceFilePreview } from "@/components/chat/workspace-file-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type OpenFileTab,
	type UploadTarget,
	canMoveWorkspaceItemIntoDirectory,
	WORKSPACE_ROOT_ID,
	WORKSPACE_TREE_INDENT,
	type WorkspaceTreeItem,
} from "@/lib/workspace-model";
import { cn } from "@/lib/utils";

/** Workspace 文件树实例类型。 */
type WorkspaceTreeInstance = ReturnType<typeof useTree<WorkspaceTreeItem>>;

/** Workspace 下拉选择项。 */
interface WorkspaceProjectOption {
	/** Project ID。 */
	id: string;
	/** Project 名称。 */
	name: string;
	/** Project 描述。 */
	description: string | null;
	/** Project 更新时间。 */
	updatedAt: string;
}

/** Workspace 面板组件属性。 */
interface WorkspacePanelProps {
	/** 当前 project ID。 */
	projectId: string | null;
	/** 当前 project 名称。 */
	projectName: string | null;
	/** 可选 project 列表。 */
	projects: WorkspaceProjectOption[];
	/** 当前是否已有选中的 project。 */
	hasProject: boolean;
	/** workspace 文件树实例。 */
	workspaceTree: WorkspaceTreeInstance;
	/** workspace 文件树数据。 */
	workspaceItems: Record<string, WorkspaceTreeItem>;
	/** 当前文件树错误。 */
	workspaceError: string | null;
	/** 是否已加载过文件树。 */
	hasLoadedWorkspaceTree: boolean;
	/** 是否正在加载文件树。 */
	isWorkspaceLoading: boolean;
	/** 是否正在执行 workspace 变更。 */
	isWorkspaceMutating: boolean;
	/** 被截断的目录项。 */
	truncatedWorkspaceItems: WorkspaceTreeItem[];
	/** 已打开的文件标签。 */
	openFileTabs: OpenFileTab[];
	/** 当前激活文件路径。 */
	activeFilePath: string | null;
	/** 当前激活文件标签。 */
	activeFileTab: OpenFileTab | null;
	/** 是否展示文件预览面板。 */
	hasPreviewPanel: boolean;
	/** 切换文件预览模式。 */
	onFileModeChange: (path: string, mode: OpenFileTab["mode"]) => void;
	/** 文件保存后回调。 */
	onFileSaved?: (path: string) => void | Promise<void>;
	/** 刷新文件树。 */
	onRefreshWorkspaceTree: () => void;
	/** 选择文件树项。 */
	onSelectWorkspaceItem: (item: WorkspaceTreeItem) => void;
	/** 删除文件树项。 */
	onDeleteWorkspaceItem: (item: WorkspaceTreeItem) => void;
	/** 打开重命名弹窗。 */
	onOpenRenameDialog: (item: WorkspaceTreeItem) => void;
	/** 打开新建文件夹弹窗。 */
	onOpenCreateDirectoryDialog: (parent?: WorkspaceTreeItem) => void;
	/** 打开上传弹窗。 */
	onOpenUploadDialog: (mode: UploadTarget["mode"], parent?: WorkspaceTreeItem) => void;
	/** 关闭文件标签。 */
	onCloseFileTab: (path: string) => void;
	/** 激活文件标签。 */
	onSetActiveFilePath: (path: string) => void;
	/** 选择 project。 */
	onSelectProject: (project: WorkspaceProjectOption) => void;
	/** 拖拽节点进入目标目录。 */
	onMoveWorkspaceItemIntoDirectory: (
		source: WorkspaceTreeItem,
		targetDirectory: WorkspaceTreeItem,
	) => void;
}

/**
 * Chat 页面 workspace 文件树和预览面板。
 * @param props 组件属性
 * @returns workspace 面板
 */
export function WorkspacePanel(props: WorkspacePanelProps) {
	const {
		hasProject,
		projectId,
		projectName,
		projects,
		workspaceTree,
		workspaceItems,
		workspaceError,
		hasLoadedWorkspaceTree,
		isWorkspaceLoading,
		isWorkspaceMutating,
		truncatedWorkspaceItems,
		openFileTabs,
		activeFilePath,
		activeFileTab,
		hasPreviewPanel,
		onFileModeChange,
		onFileSaved,
		onRefreshWorkspaceTree,
		onSelectWorkspaceItem,
		onDeleteWorkspaceItem,
		onOpenRenameDialog,
		onOpenCreateDirectoryDialog,
		onOpenUploadDialog,
		onCloseFileTab,
		onSetActiveFilePath,
		onSelectProject,
		onMoveWorkspaceItemIntoDirectory,
	} = props;
	const [draggingPath, setDraggingPath] = useState<string | null>(null);
	const [dragOverDirectoryPath, setDragOverDirectoryPath] = useState<string | null>(null);
	const rootItem = workspaceItems[WORKSPACE_ROOT_ID];
	const draggingItem = draggingPath ? workspaceItems[draggingPath] : undefined;
	const canDropToRoot = canMoveWorkspaceItemIntoDirectory(draggingItem, rootItem);
	const isRootDropTarget = canDropToRoot && dragOverDirectoryPath === "";

	return (
		<>
			<ResizablePanel defaultSize="17%" minSize="14%" maxSize="25%">
				<section className="flex h-full min-h-0 min-w-0 flex-col border-r bg-muted/20">
					<header className="flex shrink-0 flex-col gap-3 border-b p-4">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<h1 className="truncate text-base font-semibold">Neo Noumi Chat</h1>
								<p className="truncate text-sm text-muted-foreground">
									{projectName ?? "默认工作区"}
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
								<span className="truncate">{projectName ?? "选择工作区"}</span>
								<ChevronDownIcon data-icon="inline-end" />
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-72">
								<DropdownMenuGroup>
									<DropdownMenuLabel>工作区</DropdownMenuLabel>
									{projects.map((item) => (
										<DropdownMenuItem
											key={item.id}
											onClick={() => onSelectProject(item)}
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
											disabled={!hasProject || isWorkspaceMutating}
										/>
									}
								>
									<FileUpIcon data-icon="inline-start" />
									上传
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										disabled={!hasProject || isWorkspaceMutating}
										onClick={() => onOpenUploadDialog("files")}
									>
										<FileUpIcon />
										上传文件
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={!hasProject || isWorkspaceMutating}
										onClick={() => onOpenUploadDialog("directory")}
									>
										<FolderUpIcon />
										上传文件夹
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
							<Button
								variant="outline"
								size="sm"
								disabled={!hasProject || isWorkspaceLoading}
								onClick={onRefreshWorkspaceTree}
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
								<div
									className={cn(
										"flex min-h-full flex-col gap-3 p-3 transition-colors",
										isRootDropTarget &&
											"bg-primary/5 ring-2 ring-inset ring-primary/30",
									)}
									onDragEnter={(event) => {
										if (!canDropToRoot) {
											return;
										}
										event.preventDefault();
										setDragOverDirectoryPath("");
									}}
									onDragOver={(event) => {
										if (!canDropToRoot) {
											return;
										}
										event.preventDefault();
										event.dataTransfer.dropEffect = "move";
										setDragOverDirectoryPath("");
									}}
									onDragLeave={() => {
										if (dragOverDirectoryPath === "") {
											setDragOverDirectoryPath(null);
										}
									}}
									onDrop={(event) => {
										if (!canDropToRoot || !draggingItem || !rootItem) {
											return;
										}
										event.preventDefault();
										setDraggingPath(null);
										setDragOverDirectoryPath(null);
										onMoveWorkspaceItemIntoDirectory(draggingItem, rootItem);
									}}
								>
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
									{isWorkspaceLoading &&
									workspaceItems[WORKSPACE_ROOT_ID]?.children?.length === 0 ? (
										<div className="flex flex-col gap-2">
											<Skeleton className="h-8" />
											<Skeleton className="h-8" />
											<Skeleton className="h-8" />
										</div>
									) : null}
									<Tree
										tree={workspaceTree}
										indent={WORKSPACE_TREE_INDENT}
										className="gap-0.5"
									>
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
												const canDrop = canMoveWorkspaceItemIntoDirectory(
													draggingItem,
													data,
												);
												const isDropTarget =
													canDrop && dragOverDirectoryPath === data.path;
												return (
													<ContextMenu key={item.getId()}>
														<ContextMenuTrigger className="block">
															<TreeItem
																item={item}
																className="w-full"
																draggable={!isWorkspaceMutating}
																onDragStart={(event) => {
																	event.dataTransfer.effectAllowed = "move";
																	event.dataTransfer.setData(
																		"text/plain",
																		data.path,
																	);
																	setDraggingPath(data.path);
																}}
																onDragEnd={() => {
																	setDraggingPath(null);
																	setDragOverDirectoryPath(null);
																}}
															>
																<TreeItemLabel
																	className={cn(
																		"w-full justify-start rounded-md bg-transparent",
																		isActive && "bg-accent text-accent-foreground",
																		isDropTarget &&
																			"bg-primary/10 text-primary ring-2 ring-primary/40",
																	)}
																	onDragEnter={(event) => {
																		event.stopPropagation();
																		if (!canDrop) {
																			return;
																		}
																		event.preventDefault();
																		setDragOverDirectoryPath(data.path);
																	}}
																	onDragOver={(event) => {
																		event.stopPropagation();
																		if (!canDrop) {
																			return;
																		}
																		event.preventDefault();
																		event.dataTransfer.dropEffect = "move";
																		setDragOverDirectoryPath(data.path);
																	}}
																	onDragLeave={(event) => {
																		event.stopPropagation();
																		if (dragOverDirectoryPath === data.path) {
																			setDragOverDirectoryPath(null);
																		}
																	}}
																	onDrop={(event) => {
																		event.stopPropagation();
																		if (!canDrop || !draggingItem) {
																			return;
																		}
																		event.preventDefault();
																		setDraggingPath(null);
																		setDragOverDirectoryPath(null);
																		onMoveWorkspaceItemIntoDirectory(draggingItem, data);
																	}}
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
																		onSelectWorkspaceItem(data);
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
																<ContextMenuItem
																	onClick={() => onOpenRenameDialog(data)}
																>
																	<Edit3Icon />
																	重命名
																</ContextMenuItem>
																{data.type === "directory" ? (
																	<>
																		<ContextMenuItem
																			onClick={() =>
																				onOpenCreateDirectoryDialog(data)
																			}
																		>
																			<FolderPlusIcon />
																			新建文件夹
																		</ContextMenuItem>
																		<ContextMenuItem
																			disabled={!hasProject || isWorkspaceMutating}
																			onClick={() =>
																				onOpenUploadDialog("files", data)
																			}
																		>
																			<FileUpIcon />
																			上传文件
																		</ContextMenuItem>
																		<ContextMenuItem
																			disabled={!hasProject || isWorkspaceMutating}
																			onClick={() =>
																				onOpenUploadDialog("directory", data)
																			}
																		>
																			<FolderUpIcon />
																			上传文件夹
																		</ContextMenuItem>
																	</>
																) : null}
																<ContextMenuItem
																	variant="destructive"
																	disabled={isWorkspaceMutating}
																	onClick={() => onDeleteWorkspaceItem(data)}
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
									disabled={!hasProject || isWorkspaceMutating}
									onClick={() => onOpenCreateDirectoryDialog()}
								>
									<FolderPlusIcon />
									新建文件夹
								</ContextMenuItem>
								<ContextMenuItem
									disabled={!hasProject || isWorkspaceMutating}
									onClick={() => onOpenUploadDialog("files")}
								>
									<FileUpIcon />
									上传文件
								</ContextMenuItem>
								<ContextMenuItem
									disabled={!hasProject || isWorkspaceMutating}
									onClick={() => onOpenUploadDialog("directory")}
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
						defaultSize="34%"
						minSize="24%"
						maxSize="50%"
					>
						<section className="flex h-full min-h-0 min-w-0 flex-col border-r bg-background">
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
										onClick={() => onSetActiveFilePath(tab.path)}
									>
										<span className="truncate">{tab.name}</span>
										<XIcon
											className="shrink-0"
											onClick={(event) => {
												event.stopPropagation();
												onCloseFileTab(tab.path);
											}}
										/>
									</button>
								))}
							</div>
							<WorkspaceFilePreview
								projectId={projectId}
								file={activeFileTab}
								onFileModeChange={onFileModeChange}
								onFileSaved={onFileSaved}
							/>
						</section>
					</ResizablePanel>
					<ResizableHandle withHandle />
				</>
			) : null}
		</>
	);
}
