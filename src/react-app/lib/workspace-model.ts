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
export function buildRenamedPath(path: string, nextName: string): string {
	const parentPath = getParentPath(path);
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
 * 判断一个路径是否命中目标路径或其子路径。
 * @param path 待判断路径
 * @param target 目标路径
 * @returns 是否属于同一节点或子节点
 */
export function isPathOrChild(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
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
