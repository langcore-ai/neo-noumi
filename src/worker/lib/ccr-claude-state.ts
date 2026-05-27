/** Claude Code 本地 project state 根目录。 */
const CLAUDE_PROJECT_STATE_ROOT = "/root/.claude/projects";

/**
 * 生成 Claude Code 针对 cwd 使用的本地 project state 目录。
 * @param workspacePath Claude Code 进程 cwd
 * @returns Claude Code project state 目录
 */
export function buildClaudeProjectStateDir(workspacePath: string): string {
	const projectKey = workspacePath.replaceAll("/", "-") || "-workspace";
	return `${CLAUDE_PROJECT_STATE_ROOT}/${projectKey}`;
}
