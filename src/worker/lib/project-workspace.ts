import { AwsClient } from "aws4fetch";

/** R2 中标记空目录的占位文件名。 */
const WORKSPACE_DIRECTORY_MARKER = ".keep";

/** 单次 workspace 列表最大返回对象数。 */
const WORKSPACE_LIST_LIMIT = 1_000;

/** R2 批量删除的单批 key 数量，和列表分页保持同一量级。 */
const WORKSPACE_DELETE_BATCH_SIZE = 1_000;

/** workspace 操作签名默认有效期，单位秒。 */
const WORKSPACE_SIGNATURE_TTL_SECONDS = 5 * 60;

/** R2 直传 URL 默认有效期，单位秒。 */
export const WORKSPACE_UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** R2 下载 URL 默认有效期，单位秒。 */
export const WORKSPACE_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** 单次直传签名最大文件数量。 */
export const WORKSPACE_UPLOAD_MAX_FILES = 500;

/** 单个直传文件最大大小，单位字节。 */
export const WORKSPACE_UPLOAD_MAX_FILE_SIZE = 100 * 1024 * 1024;

/** MCP/全量写入单文件最大大小，单位字节。 */
export const WORKSPACE_WRITE_MAX_FILE_SIZE = 2 * 1024 * 1024;

/** MCP 读取单文件最大大小，单位字节。 */
export const WORKSPACE_READ_MAX_FILE_SIZE = 2 * 1024 * 1024;

/** 单次目录批量变更最大对象数。 */
export const WORKSPACE_MUTATION_MAX_OBJECTS = 2_000;

/** workspace 支持的操作类型。 */
type WorkspaceOperation =
	| "list"
	| "read"
	| "write"
	| "upload"
	| "delete"
	| "move"
	| "copy"
	| "mkdir";

/** workspace API 运行所需 Worker 绑定。 */
export interface ProjectWorkspaceBindings {
	/** Project workspace 使用的 R2 bucket。 */
	PROJECT_WORKSPACE_BUCKET: R2Bucket;
	/** workspace 操作签名密钥。 */
	WORKSPACE_SIGNING_SECRET?: string;
	/** Cloudflare 账号 ID，用于构造 R2 S3 API endpoint。 */
	R2_ACCOUNT_ID?: string;
	/** R2 S3 API access key ID，用于生成前端直传 URL。 */
	R2_ACCESS_KEY_ID?: string;
	/** R2 S3 API secret access key，用于生成前端直传 URL。 */
	R2_SECRET_ACCESS_KEY?: string;
	/** Project workspace R2 bucket 名称，用于生成前端直传 URL。 */
	PROJECT_WORKSPACE_BUCKET_NAME?: string;
}

/** workspace 文件树节点。 */
export type WorkspaceTreeNode = {
	/** 相对 workspace 根目录的路径。 */
	path: string;
	/** 节点名称。 */
	name: string;
	/** 节点类型。 */
	type: "directory" | "file";
	/** 文件大小；目录没有该字段。 */
	size?: number;
	/** R2 对象上传时间；目录没有该字段。 */
	uploaded?: string;
};

/** workspace 路径状态。 */
export type WorkspacePathStat = {
	/** 相对 workspace 根目录的路径；根目录为空字符串。 */
	path: string;
	/** 节点类型。 */
	type: "directory" | "file";
	/** 文件大小；目录为空。 */
	size?: number;
	/** R2 etag；目录为空。 */
	etag?: string;
	/** R2 object version；目录为空。 */
	version?: string;
	/** R2 对象上传时间；目录为空。 */
	uploaded?: string;
	/** 文件内容类型；目录为空。 */
	contentType?: string;
	/** 目录下是否至少存在一个对象。 */
	hasChildren?: boolean;
};

/** workspace 删除结果。 */
export type WorkspaceDeleteResult = {
	/** 被请求删除的 workspace 路径。 */
	path: string;
	/** 提交给 R2 删除的对象数量。 */
	deletedObjectCount: number;
};

/** workspace 上传 URL 输入。 */
export type WorkspaceUploadUrlInput = {
	/** 相对目标目录的文件路径，文件夹上传时包含子目录。 */
	relativePath: string;
	/** 文件大小，单位字节。 */
	size: number;
	/** 文件 MIME 类型。 */
	contentType?: string;
};

/** workspace 直传 URL。 */
export type WorkspaceUploadUrl = {
	/** 文件 workspace 相对路径。 */
	path: string;
	/** 前端直接 PUT 到 R2 的短期签名 URL。 */
	uploadUrl: string;
	/** 上传方法。 */
	method: "PUT";
	/** 前端上传时必须携带的请求头。 */
	headers: Record<string, string>;
	/** 签名过期 Unix 秒时间戳。 */
	expiresAt: number;
};

/** workspace 下载 URL。 */
export type WorkspaceDownloadUrl = {
	/** 文件 workspace 相对路径。 */
	path: string;
	/** 前端或容器可直接 GET 的短期签名 URL。 */
	downloadUrl: string;
	/** 下载方法。 */
	method: "GET";
	/** 签名过期 Unix 秒时间戳。 */
	expiresAt: number;
	/** 文件大小，单位字节。 */
	size: number;
	/** 文件 etag。 */
	etag: string;
	/** 文件内容类型。 */
	contentType: string;
	/** R2 上传时间。 */
	uploaded: string;
};

/** 已签名 workspace 操作上下文。 */
export type SignedWorkspaceOperation = {
	/** 操作类型。 */
	operation: WorkspaceOperation;
	/** Project ID，也是 R2 workspace 根目录。 */
	projectId: string;
	/** 操作路径。 */
	path: string;
	/** 签名过期 Unix 秒时间戳。 */
	expiresAt: number;
	/** 后端生成的 HMAC 签名。 */
	signature: string;
};

/**
 * 规范化 workspace 相对路径，避免越权访问 project 根目录外对象。
 * @param path 原始路径
 * @param options 规范化选项
 * @returns 安全相对路径
 */
export function normalizeWorkspacePath(
	path: string | undefined,
	options: { allowEmpty?: boolean } = {},
): string {
	const rawPath = (path ?? "").trim().replaceAll("\\", "/");
	if ([...rawPath].some((char) => {
		const code = char.charCodeAt(0);
		return code <= 31 || code === 127;
	})) {
		throw new Error("Workspace path cannot contain control characters");
	}
	if (/^[A-Za-z]:/.test(rawPath)) {
		throw new Error("Workspace path cannot be a Windows drive path");
	}
	const parts: string[] = [];
	for (const part of rawPath.split("/")) {
		const trimmedPart = part.trim();
		if (!trimmedPart || trimmedPart === ".") {
			continue;
		}
		if (trimmedPart === "..") {
			throw new Error("Workspace path cannot contain parent traversal");
		}
		parts.push(trimmedPart);
	}
	const normalized = parts.join("/");
	if (!normalized && !options.allowEmpty) {
		throw new Error("Workspace path is required");
	}
	return normalized;
}

/**
 * 判断路径是否位于指定目录下。
 * @param path 待判断路径
 * @param parentPath 父目录路径
 * @returns 是否是同一路径或子路径
 */
function isPathOrChild(path: string, parentPath: string): boolean {
	return path === parentPath || path.startsWith(`${parentPath}/`);
}

/**
 * 列出路径的父级路径。
 * @param path workspace 相对路径
 * @returns 从近根到近叶子的父级路径
 */
function listParentPaths(path: string): string[] {
	const parts = normalizeWorkspacePath(path).split("/");
	return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * 构造 R2 对象 key。
 * @param projectId Project ID
 * @param path workspace 相对路径
 * @returns R2 object key
 */
export function buildWorkspaceObjectKey(projectId: string, path = ""): string {
	const normalizedPath = normalizeWorkspacePath(path, { allowEmpty: true });
	return normalizedPath ? `${projectId}/${normalizedPath}` : `${projectId}/`;
}

/**
 * 生成空目录占位对象路径。
 * @param directoryPath 目录路径
 * @returns 目录 marker 路径
 */
function directoryMarkerPath(directoryPath: string): string {
	const normalizedPath = normalizeWorkspacePath(directoryPath);
	return `${normalizedPath}/${WORKSPACE_DIRECTORY_MARKER}`;
}

/**
 * 拼接上传目标路径。
 * @param basePath 目标父目录路径
 * @param relativePath 上传文件相对路径
 * @returns workspace 相对路径
 */
function buildWorkspaceUploadPath(basePath: string, relativePath: string): string {
	const normalizedBasePath = normalizeWorkspacePath(basePath, { allowEmpty: true });
	const normalizedRelativePath = normalizeWorkspacePath(relativePath);
	return normalizedBasePath
		? `${normalizedBasePath}/${normalizedRelativePath}`
		: normalizedRelativePath;
}

/**
 * 编码 R2 S3 API 路径，保留 workspace 目录分隔符。
 * @param path R2 key 或 bucket/key 路径
 * @returns URL path 安全字符串
 */
function encodeR2Path(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * 创建 R2 S3 API 签名客户端。
 * @param env Worker 绑定
 * @returns AWS V4 签名客户端
 */
function createR2SigningClient(
	env: Pick<
		ProjectWorkspaceBindings,
		"R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY"
	>,
): AwsClient {
	if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
		throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
	}
	return new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		region: "auto",
		service: "s3",
	});
}

/**
 * 构造 R2 S3 API 对象 URL。
 * @param accountId Cloudflare 账号 ID
 * @param bucketName R2 bucket 名称
 * @param key R2 object key
 * @returns R2 S3 API URL
 */
function buildR2ObjectUrl(accountId: string, bucketName: string, key: string): string {
	const encodedPath = encodeR2Path(`${bucketName}/${key}`);
	return `https://${accountId}.r2.cloudflarestorage.com/${encodedPath}`;
}

/**
 * 为 R2 对象生成短期 S3 presigned URL。
 * @param env R2 签名所需 Worker 绑定
 * @param input 签名参数
 * @returns 签名 URL 和过期时间
 */
async function createPresignedWorkspaceObjectUrl(
	env: Pick<
		ProjectWorkspaceBindings,
		| "R2_ACCOUNT_ID"
		| "R2_ACCESS_KEY_ID"
		| "R2_SECRET_ACCESS_KEY"
		| "PROJECT_WORKSPACE_BUCKET_NAME"
	>,
	input: {
		/** R2 object key。 */
		key: string;
		/** HTTP 方法。 */
		method: "GET" | "PUT";
		/** 签名有效期，单位秒。 */
		expiresInSeconds: number;
		/** 需要参与签名的请求头。 */
		headers?: Record<string, string>;
	},
) {
	if (!env.R2_ACCOUNT_ID) {
		throw new Error("R2_ACCOUNT_ID is required");
	}
	if (!env.PROJECT_WORKSPACE_BUCKET_NAME) {
		throw new Error("PROJECT_WORKSPACE_BUCKET_NAME is required");
	}
	const uploadUrl = new URL(
		buildR2ObjectUrl(
			env.R2_ACCOUNT_ID,
			env.PROJECT_WORKSPACE_BUCKET_NAME,
			input.key,
		),
	);
	uploadUrl.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));
	const signed = await createR2SigningClient(env).sign(
		uploadUrl,
		{
			headers: input.headers,
			method: input.method,
			// R2 S3 presigned URL 通过 query 参数授权，调用方无需持有密钥。
			aws: { signQuery: true },
		},
	);
	return {
		url: signed.url,
		expiresAt: Math.floor(Date.now() / 1000) + input.expiresInSeconds,
	};
}

/**
 * 从 R2 key 还原 workspace 相对路径。
 * @param projectId Project ID
 * @param key R2 object key
 * @returns workspace 相对路径
 */
function pathFromWorkspaceKey(projectId: string, key: string): string {
	const prefix = `${projectId}/`;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * 读取字符串的 SHA-256 十六进制摘要。
 * @param value 输入字符串
 * @returns 十六进制摘要
 */
async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * 使用 HMAC-SHA256 签名 workspace 操作。
 * @param secret 签名密钥
 * @param payload 待签名内容
 * @returns 十六进制签名
 */
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * 为 workspace 操作生成后端签名。
 * @param env Worker 绑定
 * @param input 操作上下文
 * @returns 签名结果
 */
export async function signWorkspaceOperation(
	env: Pick<ProjectWorkspaceBindings, "WORKSPACE_SIGNING_SECRET">,
	input: {
		operation: WorkspaceOperation;
		projectId: string;
		path?: string;
		body?: string;
	},
): Promise<SignedWorkspaceOperation> {
	const secret = env.WORKSPACE_SIGNING_SECRET;
	if (!secret) {
		throw new Error("WORKSPACE_SIGNING_SECRET is required");
	}
	const normalizedPath = normalizeWorkspacePath(input.path, { allowEmpty: true });
	const expiresAt = Math.floor(Date.now() / 1000) + WORKSPACE_SIGNATURE_TTL_SECONDS;
	const bodyHash = await sha256Hex(input.body ?? "");
	const payload = [
		input.operation,
		input.projectId,
		normalizedPath,
		bodyHash,
		expiresAt,
	].join("\n");
	return {
		operation: input.operation,
		projectId: input.projectId,
		path: normalizedPath,
		expiresAt,
		signature: await hmacSha256Hex(secret, payload),
	};
}

/**
 * 列出 project workspace 文件树。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param prefix 可选 workspace 路径前缀
 * @param cursor R2 分页游标
 * @returns 文件树节点
 */
export async function listWorkspaceTree(
	bucket: R2Bucket,
	projectId: string,
	prefix = "",
	cursor?: string,
): Promise<{ nodes: WorkspaceTreeNode[]; truncated: boolean; cursor?: string }> {
	const normalizedPrefix = normalizeWorkspacePath(prefix, { allowEmpty: true });
	const r2Prefix = normalizedPrefix
		? `${buildWorkspaceObjectKey(projectId, normalizedPrefix)}/`
		: buildWorkspaceObjectKey(projectId);
	const listed = await bucket.list({
		prefix: r2Prefix,
		limit: WORKSPACE_LIST_LIMIT,
		cursor,
	});
	const directories = new Map<string, WorkspaceTreeNode>();
	const files: WorkspaceTreeNode[] = [];
	for (const object of listed.objects) {
		const path = pathFromWorkspaceKey(projectId, object.key);
		if (!path) {
			continue;
		}
		const markerSuffix = `/${WORKSPACE_DIRECTORY_MARKER}`;
		const isDirectoryMarker = path.endsWith(markerSuffix);
		const visiblePath = isDirectoryMarker
			? path.slice(0, -markerSuffix.length)
			: path;
		if (!visiblePath || visiblePath === normalizedPrefix) {
			continue;
		}
		const relativePath = normalizedPrefix
			? visiblePath.slice(`${normalizedPrefix}/`.length)
			: visiblePath;
		const [firstPart, ...restParts] = relativePath.split("/");
		if (!firstPart) {
			continue;
		}
		if (isDirectoryMarker || restParts.length > 0) {
			const directoryPath = normalizedPrefix
				? `${normalizedPrefix}/${firstPart}`
				: firstPart;
			directories.set(directoryPath, {
				path: directoryPath,
				name: firstPart,
				type: "directory",
			});
			continue;
		}
		files.push({
			path: visiblePath,
			name: firstPart,
			type: "file",
			size: object.size,
			uploaded: object.uploaded.toISOString(),
		});
	}
	return {
		nodes: [...directories.values(), ...files].sort((left, right) => {
			if (left.type !== right.type) {
				return left.type === "directory" ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		}),
		truncated: listed.truncated,
		cursor: listed.truncated ? listed.cursor : undefined,
	};
}

/**
 * 读取 workspace 文件。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path workspace 相对路径
 * @returns 文件内容；不存在返回 null
 */
export async function readWorkspaceFile(
	bucket: R2Bucket,
	projectId: string,
	path: string,
) {
	const normalizedPath = normalizeWorkspacePath(path);
	const object = await bucket.get(buildWorkspaceObjectKey(projectId, normalizedPath));
	if (!object) {
		return null;
	}
	return {
		path: normalizedPath,
		content: await object.text(),
		size: object.size,
		etag: object.etag,
		uploaded: object.uploaded.toISOString(),
		contentType: object.httpMetadata?.contentType ?? "text/plain; charset=utf-8",
	};
}

/**
 * 查询 workspace 路径状态。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path workspace 相对路径；空路径表示根目录
 * @returns 路径状态；不存在返回 null
 */
export async function statWorkspacePath(
	bucket: R2Bucket,
	projectId: string,
	path = "",
): Promise<WorkspacePathStat | null> {
	const normalizedPath = normalizeWorkspacePath(path, { allowEmpty: true });
	if (!normalizedPath) {
		return { path: "", type: "directory", hasChildren: true };
	}
	const exactKey = buildWorkspaceObjectKey(projectId, normalizedPath);
	const object = await bucket.head(exactKey);
	if (object) {
		return {
			path: normalizedPath,
			type: "file",
			size: object.size,
			etag: object.etag,
			version: object.version,
			uploaded: object.uploaded.toISOString(),
			contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
		};
	}
	const listed = await bucket.list({
		prefix: `${exactKey}/`,
		limit: 1,
	});
	return listed.objects.length > 0
		? { path: normalizedPath, type: "directory", hasChildren: true }
		: null;
}

/**
 * 检查 etag 前置条件。
 * @param stat 当前路径状态
 * @param ifMatch 期望 etag
 */
function assertEtagMatch(stat: WorkspacePathStat | null, ifMatch?: string) {
	if (ifMatch && stat?.etag !== ifMatch) {
		throw new Error("Workspace path etag does not match");
	}
}

/**
 * 确保目标路径的父级都不是文件。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path workspace 相对路径
 */
async function assertWorkspaceParentsAreDirectories(
	bucket: R2Bucket,
	projectId: string,
	path: string,
) {
	for (const parentPath of listParentPaths(path)) {
		// R2 允许 file 与 prefix 同名；写入前主动收紧成文件系统语义。
		if (await bucket.head(buildWorkspaceObjectKey(projectId, parentPath))) {
			throw new Error("Workspace parent path is a file");
		}
	}
}

/**
 * 写入 workspace 文件。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path workspace 相对路径
 * @param content 文件文本内容
 * @param contentType 内容类型
 * @returns R2 写入结果摘要
 */
export async function writeWorkspaceFile(
	bucket: R2Bucket,
	projectId: string,
	path: string,
	content: string,
	contentType = "text/plain; charset=utf-8",
	options: { overwrite?: boolean; ifMatch?: string } = {},
) {
	const normalizedPath = normalizeWorkspacePath(path);
	const contentSize = new TextEncoder().encode(content).byteLength;
	if (contentSize > WORKSPACE_WRITE_MAX_FILE_SIZE) {
		throw new Error("Workspace write file exceeds the maximum size");
	}
	await assertWorkspaceParentsAreDirectories(bucket, projectId, normalizedPath);
	const current = await statWorkspacePath(bucket, projectId, normalizedPath);
	if (current?.type === "directory") {
		throw new Error("Workspace path is a directory");
	}
	if (current && options.overwrite === false) {
		throw new Error("Workspace file already exists");
	}
	assertEtagMatch(current, options.ifMatch);
	const object = await bucket.put(
		buildWorkspaceObjectKey(projectId, normalizedPath),
		content,
		{
			onlyIf: options.ifMatch ? { etagMatches: options.ifMatch } : undefined,
			httpMetadata: { contentType },
		},
	);
	return {
		path: normalizedPath,
		size: object.size,
		etag: object.etag,
		uploaded: object.uploaded.toISOString(),
	};
}

/**
 * 批量生成 workspace 文件直传 URL。
 * @param env R2 签名所需 Worker 绑定
 * @param projectId Project ID
 * @param basePath 目标父目录路径
 * @param files 上传文件列表
 * @returns 直传 URL 列表
 */
export async function createWorkspaceUploadUrls(
	env: Pick<
		ProjectWorkspaceBindings,
		| "R2_ACCOUNT_ID"
		| "R2_ACCESS_KEY_ID"
		| "R2_SECRET_ACCESS_KEY"
		| "PROJECT_WORKSPACE_BUCKET_NAME"
	>,
	projectId: string,
	basePath: string,
	files: WorkspaceUploadUrlInput[],
): Promise<{ basePath: string; files: WorkspaceUploadUrl[] }> {
	if (files.length > WORKSPACE_UPLOAD_MAX_FILES) {
		throw new Error(`Workspace upload cannot exceed ${WORKSPACE_UPLOAD_MAX_FILES} files`);
	}
	const normalizedBasePath = normalizeWorkspacePath(basePath, { allowEmpty: true });
	const uploadUrls: WorkspaceUploadUrl[] = [];
	for (const input of files) {
		const targetPath = buildWorkspaceUploadPath(
			normalizedBasePath,
			input.relativePath,
		);
		if (!Number.isSafeInteger(input.size) || input.size < 0) {
			throw new Error("Workspace upload file size is invalid");
		}
		if (input.size > WORKSPACE_UPLOAD_MAX_FILE_SIZE) {
			throw new Error("Workspace upload file exceeds the maximum size");
		}
		const contentType = input.contentType || "application/octet-stream";
		const signed = await createPresignedWorkspaceObjectUrl(env, {
			key: buildWorkspaceObjectKey(projectId, targetPath),
			method: "PUT",
			expiresInSeconds: WORKSPACE_UPLOAD_URL_TTL_SECONDS,
			headers: { "content-type": contentType },
		});
		uploadUrls.push({
			path: targetPath,
			uploadUrl: signed.url,
			method: "PUT",
			headers: { "content-type": contentType },
			expiresAt: signed.expiresAt,
		});
	}
	return {
		basePath: normalizedBasePath,
		files: uploadUrls,
	};
}

/**
 * 生成 workspace 文件下载 URL。
 * @param env R2 签名所需 Worker 绑定
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path workspace 相对路径
 * @returns 下载 URL；文件不存在时返回 null
 */
export async function createWorkspaceDownloadUrl(
	env: Pick<
		ProjectWorkspaceBindings,
		| "R2_ACCOUNT_ID"
		| "R2_ACCESS_KEY_ID"
		| "R2_SECRET_ACCESS_KEY"
		| "PROJECT_WORKSPACE_BUCKET_NAME"
	>,
	bucket: R2Bucket,
	projectId: string,
	path: string,
): Promise<WorkspaceDownloadUrl | null> {
	const normalizedPath = normalizeWorkspacePath(path);
	const objectKey = buildWorkspaceObjectKey(projectId, normalizedPath);
	const object = await bucket.head(objectKey);
	if (!object) {
		return null;
	}
	const signed = await createPresignedWorkspaceObjectUrl(env, {
		key: objectKey,
		method: "GET",
		expiresInSeconds: WORKSPACE_DOWNLOAD_URL_TTL_SECONDS,
	});
	return {
		path: normalizedPath,
		downloadUrl: signed.url,
		method: "GET",
		expiresAt: signed.expiresAt,
		size: object.size,
		etag: object.etag,
		contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
		uploaded: object.uploaded.toISOString(),
	};
}

/**
 * 删除 workspace 文件或目录。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path workspace 相对路径
 * @returns 删除结果摘要
 */
export async function deleteWorkspacePath(
	bucket: R2Bucket,
	projectId: string,
	path: string,
	options: { recursive?: boolean; ifMatch?: string } = {},
): Promise<WorkspaceDeleteResult> {
	const normalizedPath = normalizeWorkspacePath(path);
	const exactKey = buildWorkspaceObjectKey(projectId, normalizedPath);
	const directoryPrefix = `${exactKey}/`;
	const keysToDelete = new Set<string>();
	const exactObject = await bucket.head(exactKey);
	let hasDirectoryObjects = false;
	if (exactObject) {
		assertEtagMatch(
			{
				path: normalizedPath,
				type: "file",
				size: exactObject.size,
				etag: exactObject.etag,
			},
			options.ifMatch,
		);
		// 文件和目录 marker 都可能是精确 key，存在时才纳入删除结果。
		keysToDelete.add(exactKey);
	}
	let cursor: string | undefined;
	do {
		// R2 没有目录实体，目录删除需要按 prefix 找到 marker 和所有子对象。
		const listed = await bucket.list({
			prefix: directoryPrefix,
			limit: WORKSPACE_LIST_LIMIT,
			cursor,
		});
		for (const object of listed.objects) {
			hasDirectoryObjects = true;
			keysToDelete.add(object.key);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	if (hasDirectoryObjects && !options.recursive) {
		throw new Error("Workspace directory delete requires recursive=true");
	}
	if (keysToDelete.size > WORKSPACE_MUTATION_MAX_OBJECTS) {
		throw new Error("Workspace delete exceeds the maximum object count");
	}

	const keys = [...keysToDelete];
	for (let index = 0; index < keys.length; index += WORKSPACE_DELETE_BATCH_SIZE) {
		// Cloudflare R2 支持批量删除；分批避免单次提交过大。
		await bucket.delete(keys.slice(index, index + WORKSPACE_DELETE_BATCH_SIZE));
	}
	return {
		path: normalizedPath,
		deletedObjectCount: keys.length,
	};
}

/**
 * 创建 workspace 空目录 marker。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param path 目录路径
 * @returns marker 摘要
 */
export async function createWorkspaceDirectory(
	bucket: R2Bucket,
	projectId: string,
	path: string,
	options: { recursive?: boolean } = {},
) {
	const normalizedPath = normalizeWorkspacePath(path);
	await assertWorkspaceParentsAreDirectories(bucket, projectId, normalizedPath);
	const exactObject = await bucket.head(buildWorkspaceObjectKey(projectId, normalizedPath));
	if (exactObject) {
		throw new Error("Workspace path is a file");
	}
	const paths = options.recursive
		? normalizedPath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))
		: [normalizedPath];
	for (const directoryPath of paths) {
		const markerPath = directoryMarkerPath(directoryPath);
		await bucket.put(buildWorkspaceObjectKey(projectId, markerPath), "", {
			httpMetadata: { contentType: "application/x-directory" },
		});
	}
	return { path: normalizedPath };
}

/** workspace 移动结果。 */
export type WorkspaceMoveResult = {
	/** 移动后的 workspace 路径。 */
	path: string;
	/** 被移动的对象数量。 */
	movedObjectCount: number;
	/** 单文件移动后的文件大小；目录移动时为空。 */
	size?: number;
	/** 单文件移动后的 etag；目录移动时为空。 */
	etag?: string;
	/** 单文件移动后的上传时间；目录移动时为空。 */
	uploaded?: string;
};

/** workspace 移动源类型。 */
export type WorkspaceMoveSourceType = "file" | "directory";

/**
 * 移动 workspace 文件或目录。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param fromPath 源路径
 * @param toPath 目标路径
 * @param sourceType 源节点类型；省略时优先按精确文件移动
 * @returns 移动后的路径摘要；源路径不存在时返回 null
 */
export async function moveWorkspacePath(
	bucket: R2Bucket,
	projectId: string,
	fromPath: string,
	toPath: string,
	sourceType?: WorkspaceMoveSourceType,
	options: { overwrite?: boolean; ifMatch?: string } = {},
): Promise<WorkspaceMoveResult | null> {
	const sourcePath = normalizeWorkspacePath(fromPath);
	const targetPath = normalizeWorkspacePath(toPath);
	if (sourcePath === targetPath) {
		return null;
	}
	await assertWorkspaceParentsAreDirectories(bucket, projectId, targetPath);
	const sourceKey = buildWorkspaceObjectKey(projectId, sourcePath);
	const targetKey = buildWorkspaceObjectKey(projectId, targetPath);
	const object = sourceType === "directory" ? null : await bucket.get(sourceKey);
	if (object && sourceType !== "directory") {
		assertEtagMatch(
			{ path: sourcePath, type: "file", size: object.size, etag: object.etag },
			options.ifMatch,
		);
		if (await statWorkspacePath(bucket, projectId, targetPath)) {
			if (options.overwrite !== true) {
				throw new Error("Workspace target path already exists");
			}
			await deleteWorkspacePath(bucket, projectId, targetPath, { recursive: true });
		}
		const moved = await bucket.put(targetKey, object.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: object.customMetadata,
		});
		await bucket.delete(sourceKey);
		return {
			path: targetPath,
			movedObjectCount: 1,
			size: moved.size,
			etag: moved.etag,
			uploaded: moved.uploaded.toISOString(),
		};
	}
	if (targetPath.startsWith(`${sourcePath}/`)) {
		throw new Error("Workspace directory cannot be moved into itself");
	}

	const sourcePrefix = `${sourceKey}/`;
	const targetPrefix = `${targetKey}/`;
	const sourceObjects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		// R2 目录是 prefix 语义，目录移动需要逐个复制并删除所有子对象。
		const listed = await bucket.list({
			prefix: sourcePrefix,
			limit: WORKSPACE_LIST_LIMIT,
			cursor,
		});
		sourceObjects.push(...listed.objects);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	if (sourceObjects.length === 0) {
		return null;
	}
	if (sourceObjects.length > WORKSPACE_MUTATION_MAX_OBJECTS) {
		throw new Error("Workspace move exceeds the maximum object count");
	}
	if (await statWorkspacePath(bucket, projectId, targetPath)) {
		if (options.overwrite !== true) {
			throw new Error("Workspace target path already exists");
		}
		await deleteWorkspacePath(bucket, projectId, targetPath, { recursive: true });
	}

	const movedKeys: string[] = [];
	for (const sourceObject of sourceObjects) {
		const childObject = await bucket.get(sourceObject.key);
		if (!childObject) {
			continue;
		}
		const targetChildKey = `${targetPrefix}${sourceObject.key.slice(sourcePrefix.length)}`;
		await bucket.put(targetChildKey, childObject.body, {
			httpMetadata: childObject.httpMetadata,
			customMetadata: childObject.customMetadata,
		});
		movedKeys.push(sourceObject.key);
	}
	for (let index = 0; index < movedKeys.length; index += WORKSPACE_DELETE_BATCH_SIZE) {
		// 复制全部成功后再批量删除源对象，避免中途失败造成源目录部分丢失。
		await bucket.delete(movedKeys.slice(index, index + WORKSPACE_DELETE_BATCH_SIZE));
	}
	return {
		path: targetPath,
		movedObjectCount: movedKeys.length,
	};
}

/**
 * 复制 workspace 文件或目录。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param fromPath 源路径
 * @param toPath 目标路径
 * @param sourceType 源节点类型；省略时优先按精确文件复制
 * @param options 复制选项
 * @returns 复制后的路径摘要；源路径不存在时返回 null
 */
export async function copyWorkspacePath(
	bucket: R2Bucket,
	projectId: string,
	fromPath: string,
	toPath: string,
	sourceType?: WorkspaceMoveSourceType,
	options: { overwrite?: boolean; ifMatch?: string } = {},
): Promise<WorkspaceMoveResult | null> {
	const sourcePath = normalizeWorkspacePath(fromPath);
	const targetPath = normalizeWorkspacePath(toPath);
	if (sourcePath === targetPath || isPathOrChild(targetPath, sourcePath)) {
		throw new Error("Workspace path cannot be copied into itself");
	}
	await assertWorkspaceParentsAreDirectories(bucket, projectId, targetPath);
	const sourceKey = buildWorkspaceObjectKey(projectId, sourcePath);
	const targetKey = buildWorkspaceObjectKey(projectId, targetPath);
	const object = sourceType === "directory" ? null : await bucket.get(sourceKey);
	if (object && sourceType !== "directory") {
		assertEtagMatch(
			{ path: sourcePath, type: "file", size: object.size, etag: object.etag },
			options.ifMatch,
		);
		if (await statWorkspacePath(bucket, projectId, targetPath)) {
			if (options.overwrite !== true) {
				throw new Error("Workspace target path already exists");
			}
			await deleteWorkspacePath(bucket, projectId, targetPath, { recursive: true });
		}
		const copied = await bucket.put(targetKey, object.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: object.customMetadata,
		});
		return {
			path: targetPath,
			movedObjectCount: 1,
			size: copied.size,
			etag: copied.etag,
			uploaded: copied.uploaded.toISOString(),
		};
	}

	const sourcePrefix = `${sourceKey}/`;
	const targetPrefix = `${targetKey}/`;
	const sourceObjects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({
			prefix: sourcePrefix,
			limit: WORKSPACE_LIST_LIMIT,
			cursor,
		});
		sourceObjects.push(...listed.objects);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	if (sourceObjects.length === 0) {
		return null;
	}
	if (sourceObjects.length > WORKSPACE_MUTATION_MAX_OBJECTS) {
		throw new Error("Workspace copy exceeds the maximum object count");
	}
	if (await statWorkspacePath(bucket, projectId, targetPath)) {
		if (options.overwrite !== true) {
			throw new Error("Workspace target path already exists");
		}
		await deleteWorkspacePath(bucket, projectId, targetPath, { recursive: true });
	}
	for (const sourceObject of sourceObjects) {
		const childObject = await bucket.get(sourceObject.key);
		if (!childObject) {
			continue;
		}
		const targetChildKey = `${targetPrefix}${sourceObject.key.slice(sourcePrefix.length)}`;
		await bucket.put(targetChildKey, childObject.body, {
			httpMetadata: childObject.httpMetadata,
			customMetadata: childObject.customMetadata,
		});
	}
	return {
		path: targetPath,
		movedObjectCount: sourceObjects.length,
	};
}

/**
 * 移动 workspace 文件。
 * @param bucket R2 bucket
 * @param projectId Project ID
 * @param fromPath 源路径
 * @param toPath 目标路径
 * @returns 移动后的文件摘要
 */
export async function moveWorkspaceFile(
	bucket: R2Bucket,
	projectId: string,
	fromPath: string,
	toPath: string,
) {
	return moveWorkspacePath(bucket, projectId, fromPath, toPath, "file", {
		overwrite: true,
	});
}
