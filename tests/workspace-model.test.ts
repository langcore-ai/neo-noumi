import { describe, expect, test } from "bun:test";
import {
	addOptimisticWorkspaceDirectory,
	canMoveWorkspaceItemIntoDirectory,
	createEmptyWorkspaceTree,
	moveOptimisticWorkspaceItem,
	removeOptimisticWorkspaceItem,
	type WorkspaceTreeItem,
	WORKSPACE_ROOT_ID,
} from "../src/react-app/lib/workspace-model";

/**
 * 构造测试用 workspace 文件树索引。
 * @returns 文件树索引
 */
function createWorkspaceItems(): Record<string, WorkspaceTreeItem> {
	return {
		...createEmptyWorkspaceTree(),
		[WORKSPACE_ROOT_ID]: {
			name: "workspace",
			path: "",
			type: "directory",
			children: ["src", "README.md"],
			isLoaded: true,
		},
		src: {
			name: "src",
			path: "src",
			type: "directory",
			children: ["src/app.ts", "src/lib"],
			isLoaded: true,
		},
		"src/app.ts": {
			name: "app.ts",
			path: "src/app.ts",
			type: "file",
			isLoaded: true,
		},
		"src/lib": {
			name: "lib",
			path: "src/lib",
			type: "directory",
			children: ["src/lib/util.ts"],
			isLoaded: true,
		},
		"src/lib/util.ts": {
			name: "util.ts",
			path: "src/lib/util.ts",
			type: "file",
			isLoaded: true,
		},
		"README.md": {
			name: "README.md",
			path: "README.md",
			type: "file",
			isLoaded: true,
		},
	};
}

describe("workspace optimistic tree helpers", () => {
	test("adds a directory to a loaded parent", () => {
		const nextItems = addOptimisticWorkspaceDirectory(
			createWorkspaceItems(),
			"src/components",
		);

		expect(nextItems["src/components"]).toMatchObject({
			name: "components",
			path: "src/components",
			type: "directory",
			children: [],
			isLoaded: true,
		});
		expect(nextItems.src.children).toEqual([
			"src/components",
			"src/lib",
			"src/app.ts",
		]);
	});

	test("removes an item subtree from its loaded parent", () => {
		const nextItems = removeOptimisticWorkspaceItem(createWorkspaceItems(), "src/lib");

		expect(nextItems["src/lib"]).toBeUndefined();
		expect(nextItems["src/lib/util.ts"]).toBeUndefined();
		expect(nextItems.src.children).toEqual(["src/app.ts"]);
	});

	test("moves a loaded directory subtree and rewrites child paths", () => {
		const nextItems = moveOptimisticWorkspaceItem(
			createWorkspaceItems(),
			"src/lib",
			"lib",
		);

		expect(nextItems["src/lib"]).toBeUndefined();
		expect(nextItems["src/lib/util.ts"]).toBeUndefined();
		expect(nextItems.lib).toMatchObject({
			name: "lib",
			path: "lib",
			type: "directory",
			children: ["lib/util.ts"],
		});
		expect(nextItems["lib/util.ts"]).toMatchObject({
			name: "util.ts",
			path: "lib/util.ts",
			type: "file",
		});
		expect(nextItems.src.children).toEqual(["src/app.ts"]);
		expect(nextItems[WORKSPACE_ROOT_ID].children).toEqual([
			"lib",
			"src",
			"README.md",
		]);
	});

	test("allows moving to root without allowing no-op or child moves", () => {
		const items = createWorkspaceItems();

		expect(canMoveWorkspaceItemIntoDirectory(items["src/app.ts"], items[WORKSPACE_ROOT_ID]))
			.toBeTrue();
		expect(canMoveWorkspaceItemIntoDirectory(items["README.md"], items[WORKSPACE_ROOT_ID]))
			.toBeFalse();
		expect(canMoveWorkspaceItemIntoDirectory(items.src, items["src/lib"])).toBeFalse();
	});
});
