import { describe, expect, test } from "bun:test";
import {
	buildClaudeProjectStateDir,
	buildProjectWorkspaceMountPath,
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

	test("falls back to project id when project name is not a valid path segment", () => {
		expect(buildProjectWorkspaceMountPath("..", "project-1")).toBe(
			"/workspace/project-1",
		);
	});
});

describe("buildClaudeProjectStateDir", () => {
	test("tracks the mounted workspace cwd", () => {
		expect(buildClaudeProjectStateDir("/workspace/A")).toBe(
			"/root/.claude/projects/-workspace-A",
		);
	});
});
