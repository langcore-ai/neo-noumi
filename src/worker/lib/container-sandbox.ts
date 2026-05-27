import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { buildUserContainerSandboxId } from "./container-identity";

/** 用户级 Sandbox Durable Object 绑定。 */
export type UserContainerSandboxBindings = {
	/** Cloudflare Sandbox Durable Object namespace。 */
	NEO_NOUMI_SANDBOX: Env["NEO_NOUMI_SANDBOX"];
};

/**
 * 获取用户级容器的 Sandbox client。
 * @param namespace Sandbox Durable Object namespace
 * @param userId 登录用户 ID
 * @returns 可执行容器操作的 Sandbox client
 */
export function getUserContainerSandbox<TSandbox extends Sandbox<unknown>>(
	namespace: DurableObjectNamespace<TSandbox>,
	userId: string,
) {
	return getSandbox(namespace, buildUserContainerSandboxId(userId));
}

/**
 * 销毁用户级容器。
 * @param namespace Sandbox Durable Object namespace
 * @param userId 登录用户 ID
 * @returns 被销毁的 sandbox ID
 */
export async function destroyUserContainerSandbox<TSandbox extends Sandbox<unknown>>(
	namespace: DurableObjectNamespace<TSandbox>,
	userId: string,
): Promise<string> {
	const sandboxId = buildUserContainerSandboxId(userId);
	const sandbox = getUserContainerSandbox(namespace, userId);
	// destroy 是容器基础能力，业务层负责清理自己的数据库状态。
	await sandbox.destroy();
	return sandboxId;
}
