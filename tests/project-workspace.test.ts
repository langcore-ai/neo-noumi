import { describe, expect, test } from "bun:test";
import {
	buildWorkspaceObjectKey,
	createWorkspaceDirectory,
	listWorkspaceTree,
	moveWorkspaceFile,
	normalizeWorkspacePath,
	readWorkspaceFile,
	signWorkspaceOperation,
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
		delete: async (key: string) => {
			objects.delete(key);
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
});
