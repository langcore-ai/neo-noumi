/** Project workspace 文件树节点。 */
export interface WorkspaceTreeNode {
	path: string;
	name: string;
	type: "directory" | "file";
	size?: number;
	uploaded?: string;
}

/** workspace tree API 响应。 */
export interface WorkspaceTreeResponse {
	workspace: {
		nodes: WorkspaceTreeNode[];
		truncated: boolean;
		cursor?: string;
	};
}

/** workspace 直传 URL 响应。 */
export interface WorkspaceUploadUrlResponse {
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
export interface WorkspaceTreeItem {
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
export interface OpenFileTab {
	path: string;
	name: string;
}

/** 文件重命名弹窗状态。 */
export interface RenameTarget {
	path: string;
	name: string;
	type: "directory" | "file";
}

/** 新建文件夹弹窗状态。 */
export interface CreateDirectoryTarget {
	parentPath: string;
	parentName: string;
}

/** 上传弹窗状态。 */
export interface UploadTarget {
	parentPath: string;
	parentName: string;
	mode: "files" | "directory";
}

/** 文件树根节点 ID。 */
export const WORKSPACE_ROOT_ID = "root";

/** 文件树缩进宽度。 */
export const WORKSPACE_TREE_INDENT = 18;

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
export function getWorkspaceParentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/**
 * 计算重命名后的 workspace 路径。
 * @param path 原始路径
 * @param nextName 新名称
 * @returns 新路径
 */
export function buildRenamedPath(path: string, nextName: string): string {
	const parentPath = getWorkspaceParentPath(path);
	return parentPath ? `${parentPath}/${nextName}` : nextName;
}

/**
 * 计算新建子目录路径。
 * @param parentPath 父目录路径
 * @param name 子目录名称
 * @returns 新目录路径
 */
export function buildChildDirectoryPath(parentPath: string, name: string): string {
	return parentPath ? `${parentPath}/${name}` : name;
}

/**
 * 计算拖拽移动到目录后的 workspace 路径。
 * @param targetDirectoryPath 目标目录路径
 * @param itemName 被移动节点名称
 * @returns 移动后的路径
 */
export function buildMovedIntoDirectoryPath(
	targetDirectoryPath: string,
	itemName: string,
): string {
	return targetDirectoryPath ? `${targetDirectoryPath}/${itemName}` : itemName;
}

/**
 * 读取 workspace 路径最后一段名称。
 * @param path workspace 相对路径
 * @returns 路径名称
 */
export function getWorkspacePathName(path: string): string {
	return path.split("/").pop() || path;
}

/**
 * 判断一个路径是否命中目标路径或其子路径。
 * @param path 待判断路径
 * @param target 目标路径
 * @returns 是否属于同一节点或子节点
 */
export function isPathOrChild(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
}

/**
 * 判断 workspace 节点是否允许移动到目标目录。
 * @param source 被移动节点
 * @param targetDirectory 目标目录
 * @returns 是否允许移动
 */
export function canMoveWorkspaceItemIntoDirectory(
	source: WorkspaceTreeItem | undefined,
	targetDirectory: WorkspaceTreeItem | undefined,
): boolean {
	if (!source || !targetDirectory || targetDirectory.type !== "directory") {
		return false;
	}
	if (source.path === targetDirectory.path) {
		return false;
	}
	if (source.type === "directory" && isPathOrChild(targetDirectory.path, source.path)) {
		return false;
	}
	return getWorkspaceParentPath(source.path) !== targetDirectory.path;
}

/**
 * 按文件树展示规则排序子节点。
 * @param items 当前文件树项索引
 * @param childIds 子节点 ID 列表
 * @returns 排序后的去重子节点 ID 列表
 */
function sortWorkspaceChildIds(
	items: Record<string, WorkspaceTreeItem>,
	childIds: string[],
): string[] {
	return Array.from(new Set(childIds)).sort((leftId, rightId) => {
		const left = items[leftId] ?? createWorkspaceTreeFallbackItem(leftId);
		const right = items[rightId] ?? createWorkspaceTreeFallbackItem(rightId);
		if (left.type !== right.type) {
			return left.type === "directory" ? -1 : 1;
		}
		return left.name.localeCompare(right.name);
	});
}

/**
 * 计算路径前缀替换后的新路径。
 * @param path 原始路径
 * @param fromPath 旧路径前缀
 * @param toPath 新路径前缀
 * @returns 替换后的路径
 */
function replaceWorkspacePathPrefix(
	path: string,
	fromPath: string,
	toPath: string,
): string {
	return path === fromPath ? toPath : `${toPath}${path.slice(fromPath.length)}`;
}

/**
 * 乐观移除文件树节点及其子节点。
 * @param current 当前文件树项索引
 * @param path 要删除的路径
 * @returns 更新后的文件树项索引
 */
export function removeOptimisticWorkspaceItem(
	current: Record<string, WorkspaceTreeItem>,
	path: string,
): Record<string, WorkspaceTreeItem> {
	const nextItems = { ...current };
	const parentId = getWorkspaceParentPath(path) || WORKSPACE_ROOT_ID;
	const parent = nextItems[parentId];
	if (parent?.children) {
		nextItems[parentId] = {
			...parent,
			children: parent.children.filter((childId) => childId !== path),
		};
	}
	for (const item of Object.values(current)) {
		if (item.path && isPathOrChild(item.path, path)) {
			delete nextItems[item.path];
		}
	}
	return nextItems;
}

/**
 * 乐观新增目录节点。
 * @param current 当前文件树项索引
 * @param path 目录路径
 * @returns 更新后的文件树项索引
 */
export function addOptimisticWorkspaceDirectory(
	current: Record<string, WorkspaceTreeItem>,
	path: string,
): Record<string, WorkspaceTreeItem> {
	const nextItems = { ...current };
	const parentId = getWorkspaceParentPath(path) || WORKSPACE_ROOT_ID;
	nextItems[path] = {
		name: getWorkspacePathName(path),
		path,
		type: "directory",
		children: [],
		isLoaded: true,
	};
	const parent = nextItems[parentId];
	if (parent?.children) {
		const childIds = parent.children.includes(path)
			? parent.children
			: [...parent.children, path];
		nextItems[parentId] = {
			...parent,
			children: sortWorkspaceChildIds(nextItems, childIds),
		};
	}
	return nextItems;
}

/**
 * 乐观移动或重命名文件树节点及其子节点。
 * @param current 当前文件树项索引
 * @param fromPath 源路径
 * @param toPath 目标路径
 * @returns 更新后的文件树项索引
 */
export function moveOptimisticWorkspaceItem(
	current: Record<string, WorkspaceTreeItem>,
	fromPath: string,
	toPath: string,
): Record<string, WorkspaceTreeItem> {
	const nextItems = { ...current };
	const movedItems = Object.values(current).filter((item) =>
		isPathOrChild(item.path, fromPath),
	);
	if (movedItems.length === 0) {
		return current;
	}

	for (const item of movedItems) {
		delete nextItems[item.path];
	}
	for (const item of movedItems) {
		const nextPath = replaceWorkspacePathPrefix(item.path, fromPath, toPath);
		const nextChildren = item.children?.map((childId) =>
			replaceWorkspacePathPrefix(childId, fromPath, toPath),
		);
		nextItems[nextPath] = {
			...item,
			name: item.path === fromPath ? getWorkspacePathName(toPath) : item.name,
			path: nextPath,
			children: nextChildren,
		};
	}

	const sourceParentId = getWorkspaceParentPath(fromPath) || WORKSPACE_ROOT_ID;
	const targetParentId = getWorkspaceParentPath(toPath) || WORKSPACE_ROOT_ID;
	const sourceParent = nextItems[sourceParentId];
	if (sourceParent?.children) {
		nextItems[sourceParentId] = {
			...sourceParent,
			children: sourceParent.children.filter((childId) => childId !== fromPath),
		};
	}
	const targetParent = nextItems[targetParentId];
	if (targetParent?.children) {
		nextItems[targetParentId] = {
			...targetParent,
			children: sortWorkspaceChildIds(nextItems, [...targetParent.children, toPath]),
		};
	}
	return nextItems;
}

/**
 * 将 workspace API 节点转换成文件树数据项。
 * @param node workspace 节点
 * @returns 文件树数据项
 */
export function workspaceNodeToTreeItem(node: WorkspaceTreeNode): WorkspaceTreeItem {
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
 * 构造 Headless Tree 同步读取时使用的兜底节点。
 * @param itemId 文件树节点 ID
 * @returns 不可展开的文件树数据项
 */
export function createWorkspaceTreeFallbackItem(itemId: string): WorkspaceTreeItem {
	if (itemId === WORKSPACE_ROOT_ID) {
		return {
			name: "workspace",
			path: "",
			type: "directory",
			children: [],
			isLoaded: true,
		};
	}

	const fallbackName = itemId.split("/").pop() || itemId;
	return {
		name: fallbackName,
		path: itemId,
		type: "file",
		isLoaded: true,
	};
}

/**
 * 构造初始 workspace 文件树。
 * @returns 文件树数据
 */
export function createEmptyWorkspaceTree(): Record<string, WorkspaceTreeItem> {
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
