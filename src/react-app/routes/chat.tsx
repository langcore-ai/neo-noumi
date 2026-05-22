import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCwIcon, SendIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/chat")({
	component: ChatPage,
});

interface ChatSession {
	id: string;
	title: string | null;
	projectId: string;
	workerStatus: string;
	containerStatus: string;
	sandboxId: string | null;
	workerEpoch: number;
	updatedAt: string;
}

interface Project {
	id: string;
	name: string;
	description: string | null;
	updatedAt: string;
}

interface TimelineEvent {
	id: number;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: string;
	ephemeral: boolean;
}

/**
 * 从 API 响应中读取错误消息。
 * @param response fetch 响应
 * @returns 错误消息
 */
async function readError(response: Response): Promise<string> {
	const body = await response.json().catch(() => ({}));
	return typeof body.error === "string" ? body.error : response.statusText;
}

/**
 * CCR chat 与容器管理页面。
 * @returns 页面组件
 */
function ChatPage() {
	const streamAbortRef = useRef<AbortController | null>(null);
	const timelineIdsRef = useRef<Set<number>>(new Set());
	const [session, setSession] = useState<ChatSession | null>(null);
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [project, setProject] = useState<Project | null>(null);
	const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
	const [message, setMessage] = useState("");
	const [title, setTitle] = useState("CCR Sandbox Chat");
	const [projectName, setProjectName] = useState("Default Project");
	const [containerStatus, setContainerStatus] = useState<unknown>(null);
	const [error, setError] = useState<string | null>(null);
	const [timelineStreamStatus, setTimelineStreamStatus] = useState<
		"idle" | "connecting" | "open"
	>("idle");
	const [isBusy, setIsBusy] = useState(false);

	async function loadProjects() {
		const response = await fetch("/api/ccr/projects");
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as { projects: Project[] };
		setProjects(body.projects);
		if (!project && body.projects[0]) {
			setProject(body.projects[0]);
		}
	}

	async function loadSessions() {
		const url = project
			? `/api/ccr/projects/${project.id}/sessions`
			: "/api/ccr/sessions";
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as { sessions: ChatSession[] };
		setSessions(body.sessions);
	}

	async function loadSession(sessionId = session?.id) {
		if (!sessionId) {
			return;
		}
		closeTimelineStream();
		const response = await fetch(`/api/ccr/sessions/${sessionId}`);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		const body = (await response.json()) as {
			session: ChatSession;
			timeline: TimelineEvent[];
		};
		setSession(body.session);
		timelineIdsRef.current = new Set(body.timeline.map((event) => event.id));
		setTimeline(body.timeline);
	}

	async function runAction(action: () => Promise<void>) {
		setError(null);
		setIsBusy(true);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsBusy(false);
		}
	}

	/**
	 * 关闭当前 chat stream。
	 */
	function closeTimelineStream() {
		streamAbortRef.current?.abort();
		streamAbortRef.current = null;
		setTimelineStreamStatus("idle");
	}

	/**
	 * 合并 timeline 事件，避免 SSE 重连或快照返回造成重复展示。
	 * @param event 新 timeline 事件
	 */
	function appendTimelineEvent(event: TimelineEvent) {
		if (timelineIdsRef.current.has(event.id)) {
			return;
		}
		timelineIdsRef.current.add(event.id);
		setTimeline((current) => {
			return [...current, event].sort((a, b) => a.id - b.id);
		});
	}

	/**
	 * 解析一段 SSE frame。
	 * @param frame 原始 frame
	 * @returns 解析后的事件；注释或空 frame 返回 null
	 */
	function parseSseFrame(frame: string): { event: string; data: string; id?: number } | null {
		const lines = frame.split(/\r?\n/);
		let event = "message";
		let id: number | undefined;
		const data: string[] = [];
		for (const line of lines) {
			if (!line || line.startsWith(":")) {
				continue;
			}
			if (line.startsWith("event:")) {
				event = line.slice("event:".length).trim();
				continue;
			}
			if (line.startsWith("id:")) {
				const parsed = Number(line.slice("id:".length).trim());
				id = Number.isNaN(parsed) ? undefined : parsed;
				continue;
			}
			if (line.startsWith("data:")) {
				data.push(line.slice("data:".length).trimStart());
			}
		}
		return data.length > 0 ? { event, data: data.join("\n"), id } : null;
	}

	/**
	 * 解析 SSE JSON 负载，并把坏数据转换为可展示的错误。
	 * @param data SSE data 文本
	 * @returns JSON 对象
	 */
	function parseSseJson(data: string): Record<string, unknown> {
		try {
			return JSON.parse(data) as Record<string, unknown>;
		} catch {
			throw new Error("Timeline stream payload parse failed");
		}
	}

	/**
	 * 处理 chat SSE frame。
	 * @param frame 原始 frame
	 * @param sessionId session ID
	 * @returns 是否收到结束事件
	 */
	function handleChatStreamFrame(frame: string, sessionId: string): boolean {
		const parsed = parseSseFrame(frame);
		if (!parsed) {
			return false;
		}
		if (parsed.event === "session") {
			const body = parseSseJson(parsed.data) as { session: ChatSession | null };
			if (body.session) {
				setSession(body.session);
			}
			return false;
		}
		if (parsed.event === "timeline") {
			const body = parseSseJson(parsed.data) as {
				session_id: string;
				event: TimelineEvent;
			};
			if (body.session_id === sessionId) {
				appendTimelineEvent(body.event);
			}
			return false;
		}
		if (parsed.event === "error") {
			const body = parseSseJson(parsed.data);
			throw new Error(typeof body.error === "string" ? body.error : "Chat stream failed");
		}
		return parsed.event === "done";
	}

	/**
	 * 通过 chat API 发送消息并读取同一请求返回的 SSE。
	 */
	async function streamMessage(sessionId: string, content: string, cursor: number) {
		closeTimelineStream();
		const controller = new AbortController();
		streamAbortRef.current = controller;
		setTimelineStreamStatus("connecting");
		const response = await fetch(
			`/api/ccr/sessions/${sessionId}/messages?cursor=${cursor}`,
			{
				method: "POST",
				headers: {
					accept: "text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({ message: content }),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		if (!response.body) {
			throw new Error("Chat stream response body is empty");
		}
		setTimelineStreamStatus("open");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split(/\n\n/);
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					if (handleChatStreamFrame(frame, sessionId)) {
						return;
					}
				}
			}
			if (buffer && handleChatStreamFrame(buffer, sessionId)) {
				return;
			}
		} catch (err) {
			// 用户切换会话或离开页面时主动 abort，不应该展示为操作失败。
			if (err instanceof DOMException && err.name === "AbortError") {
				return;
			}
			throw err;
		} finally {
			if (streamAbortRef.current === controller) {
				streamAbortRef.current = null;
				setTimelineStreamStatus("idle");
			}
		}
	}

	async function createSession() {
		await runAction(async () => {
			const response = await fetch(
				project ? `/api/ccr/projects/${project.id}/sessions` : "/api/ccr/sessions",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ title }),
				},
			);
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as {
				session: ChatSession;
				project?: Project;
			};
			if (body.project) {
				setProject(body.project);
			}
			closeTimelineStream();
			setSession(body.session);
			timelineIdsRef.current = new Set();
			setTimeline([]);
			await loadSessions();
		});
	}

	async function createProject() {
		await runAction(async () => {
			const response = await fetch("/api/ccr/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: projectName }),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as { project: Project };
			closeTimelineStream();
			setProject(body.project);
			setSession(null);
			timelineIdsRef.current = new Set();
			setTimeline([]);
			await loadProjects();
		});
	}

	async function sendMessage() {
		if (!session || !message.trim()) {
			return;
		}
		const sessionId = session.id;
		const content = message;
		const cursor = timeline.reduce((maxId, event) => Math.max(maxId, event.id), 0);
		await runAction(async () => {
			setMessage("");
			await streamMessage(sessionId, content, cursor);
		});
	}

	async function callContainer(action: "start" | "stop" | "destroy" | "status") {
		if (!session) {
			return;
		}
		await runAction(async () => {
			const response = await fetch(
				`/api/ccr/sessions/${session.id}/container/${action}`,
				{ method: action === "status" ? "GET" : "POST" },
			);
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			setContainerStatus(await response.json());
			await loadSession(session.id);
		});
	}

	async function deleteSession(sessionId: string) {
		const previousSessions = sessions;
		await runAction(async () => {
			// 先做乐观删除，避免后台容器清理影响列表交互。
			setSessions((current) => current.filter((item) => item.id !== sessionId));
			const response = await fetch(`/api/ccr/sessions/${sessionId}`, {
				method: "DELETE",
			});
			if (!response.ok) {
				setSessions(previousSessions);
				throw new Error(await readError(response));
			}
			if (session?.id === sessionId) {
				// 删除当前会话时同步清空详情，并关闭对应 SSE。
				closeTimelineStream();
				setSession(null);
				timelineIdsRef.current = new Set();
				setTimeline([]);
				setContainerStatus(null);
			}
		});
	}

	useEffect(() => {
		void fetch("/api/ccr/projects")
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(await readError(response));
				}
				return response.json() as Promise<{ projects: Project[] }>;
			})
			.then((body) => {
				setProjects(body.projects);
				if (body.projects[0]) {
					setProject(body.projects[0]);
				}
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	useEffect(() => {
		const url = project?.id
			? `/api/ccr/projects/${project.id}/sessions`
			: "/api/ccr/sessions";
		void fetch(url)
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(await readError(response));
				}
				return response.json() as Promise<{ sessions: ChatSession[] }>;
			})
			.then((body) => setSessions(body.sessions))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [project?.id]);

	useEffect(() => {
		return () => closeTimelineStream();
	}, []);

	return (
		<main className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto grid w-full max-w-7xl gap-6 lg:grid-cols-[320px_1fr]">
				<aside className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle>CCR Chat</CardTitle>
							<CardDescription>Cloudflare Sandbox 会话控制台。</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3">
							<div className="grid gap-2">
								<Label htmlFor="projectName">Project 名称</Label>
								<Input
									id="projectName"
									value={projectName}
									onChange={(event) => setProjectName(event.target.value)}
								/>
							</div>
							<Button variant="outline" onClick={createProject} disabled={isBusy}>
								创建 Project
							</Button>
							<div className="grid gap-2">
								<Label htmlFor="title">新会话标题</Label>
								<Input
									id="title"
									value={title}
									onChange={(event) => setTitle(event.target.value)}
								/>
							</div>
							<Button onClick={createSession} disabled={isBusy}>
								创建会话
							</Button>
							<Link to="/" className={buttonVariants({ variant: "outline" })}>
								返回首页
							</Link>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Projects</CardTitle>
						</CardHeader>
						<CardContent className="grid gap-2">
							{projects.map((item) => (
								<Button
									key={item.id}
									variant={project?.id === item.id ? "default" : "outline"}
									className="min-w-0 justify-start overflow-hidden"
									onClick={() => {
										closeTimelineStream();
										setProject(item);
										setSession(null);
										timelineIdsRef.current = new Set();
										setTimeline([]);
									}}
								>
									<span className="block min-w-0 truncate">{item.name}</span>
								</Button>
							))}
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>历史会话</CardTitle>
							<CardDescription>
								{project ? `Project: ${project.name}` : "默认 Project"}
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-2">
							{sessions.map((item) => (
								<div
									key={item.id}
									className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2"
								>
									<Button
										variant={session?.id === item.id ? "default" : "outline"}
										className="min-w-0 justify-start overflow-hidden"
										onClick={() => void loadSession(item.id)}
									>
										<span className="block min-w-0 truncate">
											{item.title || item.id}
										</span>
									</Button>
									<Button
										variant="outline"
										size="icon"
										className="shrink-0"
										disabled={isBusy}
										aria-label={`删除会话 ${item.title || item.id}`}
										onClick={() => void deleteSession(item.id)}
									>
										<Trash2Icon className="size-4" />
									</Button>
								</div>
							))}
						</CardContent>
					</Card>
				</aside>

				<section className="space-y-4">
					{error ? (
						<Alert variant="destructive">
							<AlertTitle>操作失败</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<Card>
						<CardHeader>
							<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
								<div>
									<CardTitle>{session?.title || "尚未选择会话"}</CardTitle>
									<CardDescription>
										{session?.id ?? "创建或选择一个 CCR session 后开始。"}
									</CardDescription>
								</div>
								<div className="flex flex-wrap gap-2">
									<Badge variant="secondary">
										worker: {session?.workerStatus ?? "-"}
									</Badge>
									<Badge variant="outline">
										container: {session?.containerStatus ?? "-"}
									</Badge>
									<Badge>epoch: {session?.workerEpoch ?? 0}</Badge>
									<Badge variant="secondary">
										stream: {timelineStreamStatus}
									</Badge>
								</div>
							</div>
						</CardHeader>
						<CardContent className="grid gap-4">
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={!session || isBusy}
									onClick={() => void callContainer("start")}
								>
									启动容器
								</Button>
								<Button
									variant="outline"
									disabled={!session || isBusy}
									onClick={() => void callContainer("status")}
								>
									<RefreshCwIcon className="size-4" />
									状态
								</Button>
								<Button
									variant="outline"
									disabled={!session || isBusy}
									onClick={() => void callContainer("stop")}
								>
									<SquareIcon className="size-4" />
									停止进程
								</Button>
								<Button
									variant="destructive"
									disabled={!session || isBusy}
									onClick={() => void callContainer("destroy")}
								>
									<Trash2Icon className="size-4" />
									销毁容器
								</Button>
							</div>
							{containerStatus ? (
								<pre className="max-h-52 overflow-auto rounded-lg bg-muted p-3 text-xs">
									{JSON.stringify(containerStatus, null, 2)}
								</pre>
							) : null}
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>发送消息</CardTitle>
							<CardDescription>
								消息会写入 PG 中的 CCR client events，并触发 Sandbox runner。
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3">
							<Textarea
								value={message}
								onChange={(event) => setMessage(event.target.value)}
								placeholder="输入要发送给 Claude Code worker 的消息"
							/>
							<Button disabled={!session || isBusy} onClick={sendMessage}>
								<SendIcon className="size-4" />
								发送
							</Button>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Timeline</CardTitle>
							<CardDescription>来自 worker_events 的持久化事件。</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3">
							{timeline.length === 0 ? (
								<p className="text-sm text-muted-foreground">暂无事件。</p>
							) : (
								timeline.map((event) => (
									<div key={event.id} className="rounded-lg border p-3">
										<div className="mb-2 flex items-center justify-between gap-2">
											<Badge variant={event.ephemeral ? "secondary" : "outline"}>
												{event.event_type}
											</Badge>
											<span className="text-xs text-muted-foreground">
												{new Date(event.created_at).toLocaleString()}
											</span>
										</div>
										<pre className="overflow-auto text-xs">
											{JSON.stringify(event.payload, null, 2)}
										</pre>
									</div>
								))
							)}
						</CardContent>
					</Card>
				</section>
			</div>
		</main>
	);
}
