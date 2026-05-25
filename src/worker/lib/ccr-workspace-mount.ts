/** Project workspace 在容器内的挂载根目录。 */
export const PROJECT_WORKSPACE_ROOT = "/workspace";

/** Project workspace R2 binding 名称，用于 Sandbox bucket mount。 */
export const PROJECT_WORKSPACE_BUCKET_BINDING = "PROJECT_WORKSPACE_BUCKET";

/** Claude Code 本地 project state 根目录。 */
export const CLAUDE_PROJECT_STATE_ROOT = "/root/.claude/projects";

/**
 * 将 project 名称收敛为单个 POSIX 路径段。
 * @param projectName 用户可见 project 名称
 * @param projectId project ID，用于名称不可挂载时兜底
 * @returns 可拼接到 /workspace 下的路径段
 */
function normalizeProjectMountName(projectName: string, projectId: string): string {
	const segment = projectName
		.trim()
		.replaceAll(/[\/\\\s\u0000-\u001f\u007f]/g, "-")
		.slice(0, 80);
	// 空名称和特殊路径段都不能直接作为挂载点。
	return segment && segment !== "." && segment !== ".." ? segment : projectId;
}

/**
 * 生成 project workspace 在容器内的挂载路径。
 * @param projectName 用户可见 project 名称
 * @param projectId project ID
 * @returns 容器内绝对路径
 */
export function buildProjectWorkspaceMountPath(
	projectName: string,
	projectId: string,
): string {
	return `${PROJECT_WORKSPACE_ROOT}/${normalizeProjectMountName(projectName, projectId)}`;
}

/**
 * 生成 Sandbox SDK 挂载 R2 prefix。
 * @param projectId Project ID
 * @returns s3fs 需要的前后 `/` 包裹 prefix
 */
export function buildProjectWorkspaceMountPrefix(projectId: string): string {
	return `/${projectId}/`;
}

/**
 * 生成 Claude Code 针对 cwd 使用的本地 project state 目录。
 * @param workspacePath Claude Code 进程 cwd
 * @returns Claude Code project state 目录
 */
export function buildClaudeProjectStateDir(workspacePath: string): string {
	const projectKey = workspacePath.replaceAll("/", "-") || "-workspace";
	return `${CLAUDE_PROJECT_STATE_ROOT}/${projectKey}`;
}
