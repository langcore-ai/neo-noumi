/** Project workspace 在容器内的挂载根目录。 */
export const PROJECT_WORKSPACE_ROOT = "/workspace";

/**
 * 将 project 名称收敛为单个 POSIX 路径段。
 * @param projectName 用户可见 project 名称
 * @param projectId project ID，用于名称不可挂载时兜底
 * @returns 可拼接到 /workspace 下的路径段
 */
function normalizeProjectMountName(projectName: string, projectId: string): string {
	const segment = [...projectName.trim()]
		.map((char) => {
			const code = char.charCodeAt(0);
			// s3fs 挂载点只需要规避路径分隔符、空白和控制字符，其他项目名字符保留。
			return char === "/" ||
				char === "\\" ||
				/\s/u.test(char) ||
				code <= 0x1f ||
				code === 0x7f
				? "-"
				: char;
		})
		.join("")
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
 * 判断是否跳过 workspace R2 挂载。
 * @param value 环境变量值
 * @returns 是否跳过 s3fs 挂载
 */
export function shouldSkipWorkspaceMount(value: string | undefined): boolean {
	return value === "1";
}
