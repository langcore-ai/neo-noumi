import { describe, expect, test } from "bun:test";
import {
	buildWorkspaceObjectKey,
	copyWorkspacePath,
	createWorkspaceDirectory,
	createWorkspaceUploadUrls,
	deleteWorkspacePath,
	listWorkspaceTree,
	moveWorkspaceFile,
	moveWorkspacePath,
	normalizeWorkspacePath,
	readWorkspaceFile,
	signWorkspaceOperation,
	statWorkspacePath,
	writeWorkspaceFile,
} from "../src/worker/lib/project-workspace";

/** 测试用 R2 对象记录。 */
type FakeR2Entry = {
	/** 对象内容。 */
	content: string;
	/** HTTP metadata。 */
	httpMetadata?: R2HTTPMetadata;
	/** 自定义 metadata。 */
	customMetadata?: Record<string, string>;
	/** 上传时间。 */
	uploaded: Date;
};

/**
 * 创建测试用 R2 对象。
 * @param key 对象 key
 * @param entry 对象记录
 * @returns fake R2 object body
 */
function createFakeR2Object(key: string, entry: FakeR2Entry): R2ObjectBody {
	return {
		key,
		version: "fake-version",
		size: new TextEncoder().encode(entry.content).byteLength,
		etag: `etag-${key}`,
		httpEtag: `etag-${key}`,
		checksums: {} as R2Checksums,
		uploaded: entry.uploaded,
		httpMetadata: entry.httpMetadata,
		customMetadata: entry.customMetadata,
		range: undefined,
		storageClass: "Standard",
		writeHttpMetadata: () => undefined,
		body: new Blob([entry.content]).stream(),
		bodyUsed: false,
		arrayBuffer: async () => new TextEncoder().encode(entry.content).buffer,
		bytes: async () => new TextEncoder().encode(entry.content),
		text: async () => entry.content,
		json: async <T>() => JSON.parse(entry.content) as T,
		blob: async () => new Blob([entry.content]),
	} as R2ObjectBody;
}

/**
 * 创建测试用 R2 bucket。
 * @param initial 初始对象
 * @returns fake R2 bucket
 */
function createFakeR2Bucket(initial: Record<string, string> = {}) {
	const uploaded = new Date("2026-05-24T00:00:00.000Z");
	const objects = new Map<string, FakeR2Entry>(
		Object.entries(initial).map(([key, content]) => [
			key,
			{ content, uploaded },
		]),
	);
	const listOptions: R2ListOptions[] = [];
	const bucket = {
		head: async (key: string) => {
			const entry = objects.get(key);
			return entry ? createFakeR2Object(key, entry) : null;
		},
		get: async (key: string) => {
			const entry = objects.get(key);
			return entry ? createFakeR2Object(key, entry) : null;
		},
		put: async (key: string, value: string | ReadableStream, options?: R2PutOptions) => {
			let content = "";
			if (typeof value === "string") {
				content = value;
			} else {
				const response = new Response(value);
				content = await response.text();
			}
			const entry = {
				content,
				httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
				customMetadata: options?.customMetadata,
				uploaded,
			};
			objects.set(key, entry);
			return createFakeR2Object(key, entry);
		},
		delete: async (key: string | string[]) => {
			// R2 支持单 key 和批量 key 删除，测试桶需要覆盖目录删除路径。
			for (const item of Array.isArray(key) ? key : [key]) {
				objects.delete(item);
			}
		},
		list: async (options?: R2ListOptions) => {
			listOptions.push(options ?? {});
			const prefix = options?.prefix ?? "";
			const listedObjects = [...objects.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, entry]) => createFakeR2Object(key, entry));
			return {
				objects: listedObjects,
				delimitedPrefixes: [],
				truncated: false,
			};
		},
	};
	return {
		bucket: bucket as unknown as R2Bucket,
		objects,
		listOptions,
	};
}

describe("workspace path helpers", () => {
	test("uses project id as the R2 workspace root", () => {
		expect(buildWorkspaceObjectKey("project-1", "src/index.ts")).toBe(
			"project-1/src/index.ts",
		);
	});

	test("normalizes slash paths and rejects parent traversal", () => {
		expect(normalizeWorkspacePath("/src//index.ts")).toBe("src/index.ts");
		expect(() => normalizeWorkspacePath("../secret.txt")).toThrow(
			"Workspace path cannot contain parent traversal",
		);
	});

	test("rejects control characters and Windows drive paths", () => {
		expect(() => normalizeWorkspacePath("src/\nsecret.txt")).toThrow(
			"Workspace path cannot contain control characters",
		);
		expect(() => normalizeWorkspacePath("C:/secret.txt")).toThrow(
			"Workspace path cannot be a Windows drive path",
		);
	});
});

describe("workspace R2 operations", () => {
	test("writes, reads and moves files under project root", async () => {
		const { bucket, objects } = createFakeR2Bucket();

		await writeWorkspaceFile(bucket, "project-1", "src/a.txt", "hello");
		await expect(readWorkspaceFile(bucket, "project-1", "src/a.txt")).resolves.toMatchObject({
			path: "src/a.txt",
			content: "hello",
			size: 5,
		});

		await expect(
			moveWorkspaceFile(bucket, "project-1", "src/a.txt", "src/b.txt"),
		).resolves.toMatchObject({ path: "src/b.txt", size: 5 });
		expect(objects.has("project-1/src/a.txt")).toBe(false);
		expect(objects.has("project-1/src/b.txt")).toBe(true);
	});

	test("stats files and implicit directories", async () => {
		const { bucket } = createFakeR2Bucket({
			"project-1/src/index.ts": "code",
		});

		await expect(statWorkspacePath(bucket, "project-1", "src/index.ts")).resolves.toMatchObject({
			path: "src/index.ts",
			type: "file",
			etag: "etag-project-1/src/index.ts",
		});
		await expect(statWorkspacePath(bucket, "project-1", "src")).resolves.toMatchObject({
			path: "src",
			type: "directory",
		});
		await expect(statWorkspacePath(bucket, "project-1", "missing")).resolves.toBeNull();
	});

	test("creates files without overwriting and supports etag guarded writes", async () => {
		const { bucket } = createFakeR2Bucket({
			"project-1/src/a.txt": "old",
		});

		await expect(
			writeWorkspaceFile(bucket, "project-1", "src/a.txt", "new", undefined, {
				overwrite: false,
			}),
		).rejects.toThrow("Workspace file already exists");
		await expect(
			writeWorkspaceFile(bucket, "project-1", "src/a.txt", "new", undefined, {
				ifMatch: "stale",
			}),
		).rejects.toThrow("Workspace path etag does not match");
		await expect(
			writeWorkspaceFile(bucket, "project-1", "src/a.txt", "new", undefined, {
				ifMatch: "etag-project-1/src/a.txt",
			}),
		).resolves.toMatchObject({ path: "src/a.txt", size: 3 });
	});

	test("rejects writes and directories under a file path", async () => {
		const { bucket } = createFakeR2Bucket({
			"project-1/src": "file",
			"project-1/other.txt": "other",
		});

		await expect(writeWorkspaceFile(bucket, "project-1", "src/a.txt", "new")).rejects.toThrow(
			"Workspace parent path is a file",
		);
		await expect(createWorkspaceDirectory(bucket, "project-1", "src/nested")).rejects.toThrow(
			"Workspace parent path is a file",
		);
		await expect(
			moveWorkspacePath(bucket, "project-1", "other.txt", "src/other.txt", "file"),
		).rejects.toThrow("Workspace parent path is a file");
	});

	test("moves directories by copying all objects under the source prefix", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src/.keep": "",
			"project-1/src/index.ts": "code",
			"project-1/src/nested/a.ts": "nested",
			"project-1/src-other/file.ts": "sibling",
		});

		await expect(
			moveWorkspacePath(bucket, "project-1", "src", "archive/src", "directory"),
		).resolves.toMatchObject({
			path: "archive/src",
			movedObjectCount: 3,
		});

		expect(objects.has("project-1/src/.keep")).toBe(false);
		expect(objects.has("project-1/src/index.ts")).toBe(false);
		expect(objects.has("project-1/src/nested/a.ts")).toBe(false);
		expect(objects.get("project-1/archive/src/index.ts")?.content).toBe("code");
		expect(objects.get("project-1/archive/src/nested/a.ts")?.content).toBe("nested");
		expect(objects.has("project-1/src-other/file.ts")).toBe(true);
	});

	test("preserves target when overwrite move preconditions fail", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src/a.txt": "source",
			"project-1/target.txt": "target",
		});

		await expect(
			moveWorkspacePath(bucket, "project-1", "missing.txt", "target.txt", "file", {
				overwrite: true,
			}),
		).resolves.toBeNull();
		expect(objects.get("project-1/target.txt")?.content).toBe("target");

		await expect(
			moveWorkspacePath(bucket, "project-1", "src/a.txt", "target.txt", "file", {
				overwrite: true,
				ifMatch: "stale",
			}),
		).rejects.toThrow("Workspace path etag does not match");
		expect(objects.get("project-1/target.txt")?.content).toBe("target");
	});

	test("allows moving a file into a directory whose path starts with the file path", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src": "file",
			"project-1/src-archive/.keep": "",
		});

		await expect(
			moveWorkspacePath(bucket, "project-1", "src", "src-archive/src", "file"),
		).resolves.toMatchObject({
			path: "src-archive/src",
			movedObjectCount: 1,
		});

		expect(objects.has("project-1/src")).toBe(false);
		expect(objects.get("project-1/src-archive/src")?.content).toBe("file");
	});

	test("deletes a single file without touching sibling paths", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src/a.txt": "a",
			"project-1/src/a.txt.bak": "bak",
			"project-1/src/nested/b.txt": "b",
		});

		await expect(deleteWorkspacePath(bucket, "project-1", "src/a.txt")).resolves.toEqual({
			path: "src/a.txt",
			deletedObjectCount: 1,
		});

		expect(objects.has("project-1/src/a.txt")).toBe(false);
		expect(objects.has("project-1/src/a.txt.bak")).toBe(true);
		expect(objects.has("project-1/src/nested/b.txt")).toBe(true);
	});

	test("deletes directory marker and all objects under the directory prefix", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src/.keep": "",
			"project-1/src/index.ts": "code",
			"project-1/src/nested/a.ts": "nested",
			"project-1/src-other/file.ts": "sibling",
		});

		await expect(deleteWorkspacePath(bucket, "project-1", "src")).rejects.toThrow(
			"Workspace directory delete requires recursive=true",
		);
		await expect(
			deleteWorkspacePath(bucket, "project-1", "src", { recursive: true }),
		).resolves.toEqual({
			path: "src",
			deletedObjectCount: 3,
		});

		expect(objects.has("project-1/src/.keep")).toBe(false);
		expect(objects.has("project-1/src/index.ts")).toBe(false);
		expect(objects.has("project-1/src/nested/a.ts")).toBe(false);
		expect(objects.has("project-1/src-other/file.ts")).toBe(true);
	});

	test("requires recursive when deleting an empty directory marker", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/empty/.keep": "",
		});

		await expect(deleteWorkspacePath(bucket, "project-1", "empty")).rejects.toThrow(
			"Workspace directory delete requires recursive=true",
		);
		expect(objects.has("project-1/empty/.keep")).toBe(true);

		await expect(
			deleteWorkspacePath(bucket, "project-1", "empty", { recursive: true }),
		).resolves.toEqual({
			path: "empty",
			deletedObjectCount: 1,
		});
		expect(objects.has("project-1/empty/.keep")).toBe(false);
	});

	test("lists direct children and empty directory markers", async () => {
		const { bucket } = createFakeR2Bucket({
			"project-1/src/index.ts": "code",
			"project-1/README.md": "readme",
		});
		await createWorkspaceDirectory(bucket, "project-1", "empty");

		await expect(listWorkspaceTree(bucket, "project-1")).resolves.toMatchObject({
			truncated: false,
			nodes: [
				{ path: "empty", name: "empty", type: "directory" },
				{ path: "src", name: "src", type: "directory" },
				{ path: "README.md", name: "README.md", type: "file" },
			],
		});
	});

	test("creates recursive directory markers like mkdir -p", async () => {
		const { bucket, objects } = createFakeR2Bucket();

		await createWorkspaceDirectory(bucket, "project-1", "src/nested", { recursive: true });

		expect(objects.has("project-1/src/.keep")).toBe(true);
		expect(objects.has("project-1/src/nested/.keep")).toBe(true);
	});

	test("copies files and directories without deleting the source", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src/.keep": "",
			"project-1/src/index.ts": "code",
			"project-1/src/nested/a.ts": "nested",
		});

		await expect(
			copyWorkspacePath(bucket, "project-1", "src", "copy/src", "directory"),
		).resolves.toMatchObject({
			path: "copy/src",
			movedObjectCount: 3,
		});

		expect(objects.get("project-1/src/index.ts")?.content).toBe("code");
		expect(objects.get("project-1/copy/src/index.ts")?.content).toBe("code");
		expect(objects.get("project-1/copy/src/nested/a.ts")?.content).toBe("nested");
	});

	test("preserves target when overwrite copy preconditions fail", async () => {
		const { bucket, objects } = createFakeR2Bucket({
			"project-1/src/a.txt": "source",
			"project-1/target.txt": "target",
		});

		await expect(
			copyWorkspacePath(bucket, "project-1", "missing.txt", "target.txt", "file", {
				overwrite: true,
			}),
		).resolves.toBeNull();
		expect(objects.get("project-1/target.txt")?.content).toBe("target");

		await expect(
			copyWorkspacePath(bucket, "project-1", "src/a.txt", "target.txt", "file", {
				overwrite: true,
				ifMatch: "stale",
			}),
		).rejects.toThrow("Workspace path etag does not match");
		expect(objects.get("project-1/target.txt")?.content).toBe("target");
	});

	test("forwards R2 list cursor for paged workspace reads", async () => {
		const { bucket, listOptions } = createFakeR2Bucket({
			"project-1/src/index.ts": "code",
		});

		await listWorkspaceTree(bucket, "project-1", "src", "cursor-1");

		expect(listOptions).toEqual([
			{
				prefix: "project-1/src/",
				limit: 1_000,
				cursor: "cursor-1",
			},
		]);
	});

	test("signs workspace operations with backend secret", async () => {
		const signed = await signWorkspaceOperation(
			{ WORKSPACE_SIGNING_SECRET: "unit-test-secret" },
			{
				operation: "write",
				projectId: "project-1",
				path: "README.md",
				body: "hello",
			},
		);

		expect(signed).toMatchObject({
			operation: "write",
			projectId: "project-1",
			path: "README.md",
		});
		expect(signed.signature).toMatch(/^[a-f0-9]{64}$/);
		expect(signed.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	test("creates R2 presigned upload urls under project root", async () => {
		const upload = await createWorkspaceUploadUrls(
			{
				PROJECT_WORKSPACE_BUCKET_NAME: "test-workspaces",
				R2_ACCOUNT_ID: "account-id",
				R2_ACCESS_KEY_ID: "access-key",
				R2_SECRET_ACCESS_KEY: "secret-key",
			},
			"project-1",
			"src",
			[{ relativePath: "nested/a b.txt", size: 5, contentType: "text/plain" }],
		);

		const file = upload.files[0];
		const url = new URL(file.uploadUrl);
		expect(upload.basePath).toBe("src");
		expect(file.path).toBe("src/nested/a b.txt");
		expect(file.method).toBe("PUT");
		expect(file.headers).toEqual({ "content-type": "text/plain" });
		expect(url.hostname).toBe("account-id.r2.cloudflarestorage.com");
		expect(url.pathname).toBe("/test-workspaces/project-1/src/nested/a%20b.txt");
		expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
	});

	test("rejects presigned upload urls above the file size limit", async () => {
		await expect(
			createWorkspaceUploadUrls(
				{
					PROJECT_WORKSPACE_BUCKET_NAME: "test-workspaces",
					R2_ACCOUNT_ID: "account-id",
					R2_ACCESS_KEY_ID: "access-key",
					R2_SECRET_ACCESS_KEY: "secret-key",
				},
				"project-1",
				"src",
				[
					{
						relativePath: "large.bin",
						size: 100 * 1024 * 1024 + 1,
						contentType: "application/octet-stream",
					},
				],
			),
		).rejects.toThrow("Workspace upload file exceeds the maximum size");
	});
});
