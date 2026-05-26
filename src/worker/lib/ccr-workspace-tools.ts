import { getStringField } from "./ccr-json";
import type { CcrStore } from "./ccr-store";
import type { JsonObject } from "./ccr-types";
import {
	copyWorkspacePath,
	createWorkspaceDirectory,
	deleteWorkspacePath,
	listWorkspaceTree,
	moveWorkspacePath,
	readWorkspaceFile,
	statWorkspacePath,
	writeWorkspaceFile,
	type ProjectWorkspaceBindings,
	WORKSPACE_READ_MAX_FILE_SIZE,
	type WorkspaceMoveSourceType,
} from "./project-workspace";

/** workspace MCP 工具执行上下文。 */
export interface WorkspaceToolContext {
	/** 当前 CCR session ID。 */
	sessionId: string;
	/** 当前用户 ID，用于校验 session 归属。 */
	userId?: string;
	/** CCR store，用于从 session 推导 project。 */
	store?: CcrStore;
	/** Worker 绑定，提供 R2 bucket。 */
	env?: ProjectWorkspaceBindings;
}

/** route 侧工具定义。 */
export interface RouteToolDefinition {
	/** 工具名，对外暴露给 MCP tools/list。 */
	name: string;
	/** 工具描述。 */
	description: string;
	/** MCP inputSchema。 */
	inputSchema: JsonObject;
	/** 工具执行函数。 */
	call: (input: JsonObject, context: WorkspaceToolContext) => Promise<string>;
}

/** workspace 工具名前缀，避免和其他 route 工具冲突。 */
const WORKSPACE_TOOL_PREFIX = "workspace_";

/**
 * 读取布尔入参。
 * @param input MCP 工具入参
 * @param key 字段名
 * @param defaultValue 默认值
 * @returns 布尔值
 */
function getBooleanField(input: JsonObject, key: string, defaultValue = false): boolean {
	return typeof input[key] === "boolean" ? input[key] : defaultValue;
}

/**
 * 读取 workspace 工具必填字符串入参。
 * @param input MCP 工具入参
 * @param key 字段名
 * @returns 字符串值
 */
function requireStringField(input: JsonObject, key: string): string {
	const value = getStringField(input, key);
	if (value === undefined) {
		throw new Error(`${key} is required`);
	}
	return value;
}

/**
 * 读取可选 sourceType。
 * @param input MCP 工具入参
 * @returns sourceType
 */
function readSourceType(input: JsonObject): WorkspaceMoveSourceType | undefined {
	const sourceType = getStringField(input, "sourceType");
	if (!sourceType) {
		return undefined;
	}
	if (sourceType !== "file" && sourceType !== "directory") {
		throw new Error("sourceType must be file or directory");
	}
	return sourceType;
}

/**
 * 解析当前 session 绑定的 workspace。
 * @param context 工具执行上下文
 * @returns project ID 和 R2 bucket
 */
async function resolveWorkspace(context: WorkspaceToolContext) {
	if (!context.store || !context.env || !context.userId) {
		throw new Error("Workspace tool context is incomplete");
	}
	const session = await context.store.findUserSessionSummary(
		context.userId,
		context.sessionId,
	);
	if (!session) {
		throw new Error("Session workspace not found");
	}
	return {
		projectId: session.projectId,
		bucket: context.env.PROJECT_WORKSPACE_BUCKET,
	};
}

/**
 * 序列化 workspace 工具结果。
 * @param result 工具结果
 * @returns JSON 字符串
 */
function stringifyResult(result: JsonObject): string {
	return JSON.stringify({ ok: true, ...result });
}

/** workspace route-side MCP 工具列表。 */
export const WORKSPACE_ROUTE_TOOLS: RouteToolDefinition[] = [
	{
		name: `${WORKSPACE_TOOL_PREFIX}stat`,
		description:
			"Stat a project workspace path from the authoritative service. Returns type, size, etag and version when available.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative path. Empty means root." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const stat = await statWorkspacePath(
				workspace.bucket,
				workspace.projectId,
				getStringField(input, "path") ?? "",
			);
			return stringifyResult({ stat });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}list`,
		description:
			"List direct children under a project workspace directory. Results are paginated and sorted with directories first.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path. Empty means root." },
				cursor: { type: "string", description: "Pagination cursor from a previous call." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const workspaceTree = await listWorkspaceTree(
				workspace.bucket,
				workspace.projectId,
				getStringField(input, "path") ?? "",
				getStringField(input, "cursor"),
			);
			return stringifyResult({ workspace: workspaceTree });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}read_file`,
		description:
			"Read a text file from the project workspace and return content plus etag/version metadata for later writes.",
		inputSchema: {
			type: "object",
			required: ["path"],
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const path = requireStringField(input, "path");
			const stat = await statWorkspacePath(workspace.bucket, workspace.projectId, path);
			if (!stat) {
				throw new Error("Workspace file not found");
			}
			if (stat.type !== "file") {
				throw new Error("Workspace path is not a file");
			}
			if (stat.size !== undefined && stat.size > WORKSPACE_READ_MAX_FILE_SIZE) {
				throw new Error("Workspace read file exceeds the maximum size");
			}
			const file = await readWorkspaceFile(
				workspace.bucket,
				workspace.projectId,
				path,
			);
			if (!file) {
				throw new Error("Workspace file not found");
			}
			return stringifyResult({ file });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}mkdir`,
		description:
			"Create a workspace directory marker. Set recursive=true for mkdir -p behavior.",
		inputSchema: {
			type: "object",
			required: ["path"],
			properties: {
				path: { type: "string", description: "Workspace-relative directory path." },
				recursive: { type: "boolean", description: "Create parent directories too." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const directory = await createWorkspaceDirectory(
				workspace.bucket,
				workspace.projectId,
				requireStringField(input, "path"),
				{ recursive: getBooleanField(input, "recursive") },
			);
			return stringifyResult({ directory });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}create_file`,
		description:
			"Create a new text file by full-content write. Fails if the target path already exists.",
		inputSchema: {
			type: "object",
			required: ["path", "content"],
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
				content: { type: "string", description: "Full file content." },
				contentType: { type: "string", description: "Optional MIME content type." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const file = await writeWorkspaceFile(
				workspace.bucket,
				workspace.projectId,
				requireStringField(input, "path"),
				requireStringField(input, "content"),
				getStringField(input, "contentType"),
				{ overwrite: false },
			);
			return stringifyResult({ file });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}write_file`,
		description:
			"Overwrite a workspace text file by full-content write. Pass ifMatch with a previous etag to avoid stale writes.",
		inputSchema: {
			type: "object",
			required: ["path", "content"],
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
				content: { type: "string", description: "Full file content." },
				contentType: { type: "string", description: "Optional MIME content type." },
				ifMatch: { type: "string", description: "Optional expected source etag." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const file = await writeWorkspaceFile(
				workspace.bucket,
				workspace.projectId,
				requireStringField(input, "path"),
				requireStringField(input, "content"),
				getStringField(input, "contentType"),
				{ ifMatch: getStringField(input, "ifMatch") },
			);
			return stringifyResult({ file });
		},
	},
		{
			name: `${WORKSPACE_TOOL_PREFIX}delete`,
			description:
			"Delete a workspace file or directory. Directory deletes require recursive=true.",
		inputSchema: {
			type: "object",
			required: ["path"],
			properties: {
				path: { type: "string", description: "Workspace-relative file or directory path." },
					recursive: { type: "boolean", description: "Required for directories." },
				ifMatch: { type: "string", description: "Optional expected file etag." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const deleted = await deleteWorkspacePath(
				workspace.bucket,
				workspace.projectId,
				requireStringField(input, "path"),
				{
					recursive: getBooleanField(input, "recursive"),
					ifMatch: getStringField(input, "ifMatch"),
				},
			);
			return stringifyResult({ deleted });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}move`,
		description:
			"Move a workspace file or directory. Directory moves cannot target themselves or their descendants.",
		inputSchema: {
			type: "object",
			required: ["fromPath", "toPath"],
			properties: {
				fromPath: { type: "string", description: "Source workspace path." },
				toPath: { type: "string", description: "Target workspace path." },
				sourceType: { enum: ["file", "directory"], description: "Optional source type." },
				overwrite: { type: "boolean", description: "Overwrite existing target path." },
				ifMatch: { type: "string", description: "Optional expected source file etag." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const item = await moveWorkspacePath(
				workspace.bucket,
				workspace.projectId,
				requireStringField(input, "fromPath"),
				requireStringField(input, "toPath"),
				readSourceType(input),
				{
					overwrite: getBooleanField(input, "overwrite"),
					ifMatch: getStringField(input, "ifMatch"),
				},
			);
			if (!item) {
				throw new Error("Workspace path not found");
			}
			return stringifyResult({ item });
		},
	},
	{
		name: `${WORKSPACE_TOOL_PREFIX}copy`,
		description:
			"Copy a workspace file or directory. Use overwrite=true only when replacing the target intentionally.",
		inputSchema: {
			type: "object",
			required: ["fromPath", "toPath"],
			properties: {
				fromPath: { type: "string", description: "Source workspace path." },
				toPath: { type: "string", description: "Target workspace path." },
				sourceType: { enum: ["file", "directory"], description: "Optional source type." },
				overwrite: { type: "boolean", description: "Overwrite existing target path." },
				ifMatch: { type: "string", description: "Optional expected source file etag." },
			},
		},
		async call(input, context) {
			const workspace = await resolveWorkspace(context);
			const item = await copyWorkspacePath(
				workspace.bucket,
				workspace.projectId,
				requireStringField(input, "fromPath"),
				requireStringField(input, "toPath"),
				readSourceType(input),
				{
					overwrite: getBooleanField(input, "overwrite"),
					ifMatch: getStringField(input, "ifMatch"),
				},
			);
			if (!item) {
				throw new Error("Workspace path not found");
			}
			return stringifyResult({ item });
		},
	},
];

/**
 * 判断工具名是否为 workspace 工具。
 * @param name 工具名
 * @returns 是否为 workspace 工具
 */
export function isWorkspaceRouteToolName(name: string): boolean {
	return name.startsWith(WORKSPACE_TOOL_PREFIX);
}
