import { describe, expect, test } from "bun:test";
import {
	buildClaudeProjectStateDir,
	buildProjectWorkspaceMountPrefix,
	buildProjectWorkspaceMountPath,
	shouldSkipWorkspaceMount,
} from "../src/worker/lib/ccr-workspace-mount";

describe("buildProjectWorkspaceMountPath", () => {
	test("uses the project name as the workspace mount directory", () => {
		expect(buildProjectWorkspaceMountPath("A", "project-1")).toBe("/workspace/A");
	});

	test("normalizes path separators without changing the project prefix", () => {
		expect(buildProjectWorkspaceMountPath("foo/bar\\baz", "project-1")).toBe(
			"/workspace/foo-bar-baz",
		);
	});

	test("normalizes whitespace for s3fs friendly mount paths", () => {
		expect(buildProjectWorkspaceMountPath("Default Project", "project-1")).toBe(
			"/workspace/Default-Project",
		);
	});

	test("falls back to project id when project name is not a valid path segment", () => {
		expect(buildProjectWorkspaceMountPath("..", "project-1")).toBe(
			"/workspace/project-1",
		);
	});
});

describe("buildProjectWorkspaceMountPrefix", () => {
	test("wraps project prefix for s3fs mountBucket", () => {
		expect(buildProjectWorkspaceMountPrefix("project-1")).toBe("/project-1/");
	});
});

describe("buildClaudeProjectStateDir", () => {
	test("tracks the mounted workspace cwd", () => {
		expect(buildClaudeProjectStateDir("/workspace/A")).toBe(
			"/root/.claude/projects/-workspace-A",
		);
	});
});

describe("shouldSkipWorkspaceMount", () => {
	test("only skips R2 workspace mounting when local override is explicit", () => {
		expect(shouldSkipWorkspaceMount("1")).toBe(true);
		expect(shouldSkipWorkspaceMount("0")).toBe(false);
		expect(shouldSkipWorkspaceMount(undefined)).toBe(false);
	});
});
