import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowRightIcon,
	Edit3Icon,
	FolderKanbanIcon,
	Loader2Icon,
	MessageSquareIcon,
	PlusIcon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
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
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/projects")({
	component: ProjectsPage,
});

/** Project 管理页使用的项目摘要。 */
interface ProjectSummary {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
	_count?: {
		/** 未软删除会话数量。 */
		sessions: number;
	};
}

/** Project 表单状态。 */
interface ProjectFormState {
	/** Project 名称。 */
	name: string;
	/** Project 描述。 */
	description: string;
}

/** 空表单默认值。 */
const EMPTY_FORM: ProjectFormState = { name: "", description: "" };

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
 * 格式化日期时间。
 * @param value ISO 日期字符串
 * @returns 本地化展示文本
 */
function formatDateTime(value: string): string {
	return new Date(value).toLocaleString();
}

/**
 * Project 管理页面。
 * @returns 管理 project 的页面
 */
function ProjectsPage() {
	const authSession = authClient.useSession();
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [form, setForm] = useState<ProjectFormState>(EMPTY_FORM);
	const [editingProject, setEditingProject] = useState<ProjectSummary | null>(null);
	const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);

	const totalSessions = useMemo(
		() => projects.reduce((total, project) => total + (project._count?.sessions ?? 0), 0),
		[projects],
	);

	/**
	 * 读取当前用户 project 列表。
	 */
	async function loadProjects() {
		setIsLoading(true);
		setError(null);
		try {
			const response = await fetch("/api/projects");
			if (!response.ok) {
				throw new Error(await readError(response));
			}
			const body = (await response.json()) as { projects: ProjectSummary[] };
			setProjects(body.projects);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载项目失败");
		} finally {
			setIsLoading(false);
		}
	}

	/**
	 * 打开创建 project 弹窗。
	 */
	function openCreateDialog() {
		setEditingProject(null);
		setForm(EMPTY_FORM);
		setIsFormOpen(true);
	}

	/**
	 * 打开编辑 project 弹窗。
	 * @param project 待编辑项目
	 */
	function openEditDialog(project: ProjectSummary) {
		setEditingProject(project);
		setForm({
			name: project.name,
			description: project.description ?? "",
		});
		setIsFormOpen(true);
	}

	/**
	 * 提交创建或更新 project。
	 * @param event 表单提交事件
	 */
	async function saveProject(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setIsSaving(true);
		setError(null);
		try {
			const endpoint = editingProject
				? `/api/projects/${editingProject.id}`
				: "/api/projects";
			const response = await fetch(endpoint, {
				method: editingProject ? "PATCH" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(form),
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}

			// 以服务端返回列表顺序为准，确保更新时间排序和会话计数一致。
			await loadProjects();
			setIsFormOpen(false);
			setEditingProject(null);
			setForm(EMPTY_FORM);
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存项目失败");
		} finally {
			setIsSaving(false);
		}
	}

	/**
	 * 删除当前确认的 project。
	 */
	async function deleteProject() {
		if (!deletingProject) {
			return;
		}
		setIsDeleting(true);
		setError(null);
		try {
			const response = await fetch(`/api/projects/${deletingProject.id}`, {
				method: "DELETE",
			});
			if (!response.ok) {
				throw new Error(await readError(response));
			}

			// 删除 project 会同步隐藏它的会话，重新拉取保证统计准确。
			await loadProjects();
			setDeletingProject(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "删除项目失败");
		} finally {
			setIsDeleting(false);
		}
	}

	useEffect(() => {
		if (authSession.isPending) {
			return;
		}
		if (!authSession.data) {
			setIsLoading(false);
			return;
		}
		void loadProjects();
	}, [authSession.isPending, authSession.data]);

	if (authSession.isPending) {
		return (
			<main className="min-h-screen bg-background p-6 text-foreground">
				<section className="mx-auto flex w-full max-w-6xl flex-col gap-4">
					<Skeleton className="h-28" />
					<Skeleton className="h-80" />
				</section>
			</main>
		);
	}

	if (!authSession.data) {
		return (
			<main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>需要登录</CardTitle>
						<CardDescription>登录后才能管理自己的 project。</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<Link to="/login" className={buttonVariants({ className: "w-full" })}>
							去登录
							<ArrowRightIcon data-icon="inline-end" />
						</Link>
						<Link
							to="/"
							className={buttonVariants({ variant: "link", className: "w-fit px-0" })}
						>
							返回首页
						</Link>
					</CardContent>
				</Card>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-background text-foreground">
			<section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
				<header className="flex flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm md:flex-row md:items-start md:justify-between">
					<div className="flex min-w-0 flex-col gap-3">
						<Badge variant="secondary" className="w-fit">
							<FolderKanbanIcon data-icon="inline-start" />
							Project 管理
						</Badge>
						<div className="flex flex-col gap-2">
							<h1 className="text-3xl font-semibold leading-tight">Projects</h1>
							<p className="max-w-2xl text-sm text-muted-foreground md:text-base">
								维护 CCR 会话的项目分组，创建、改名或删除项目后会影响聊天页的工作区列表。
							</p>
						</div>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={() => void loadProjects()} disabled={isLoading}>
							<RefreshCwIcon data-icon="inline-start" />
							刷新
						</Button>
						<Button onClick={openCreateDialog}>
							<PlusIcon data-icon="inline-start" />
							新建项目
						</Button>
					</div>
				</header>

				<div className="grid gap-4 md:grid-cols-3">
					<Card>
						<CardHeader>
							<CardTitle>项目数量</CardTitle>
							<CardDescription>当前未删除项目。</CardDescription>
						</CardHeader>
						<CardContent>
							<p className="text-3xl font-semibold">{projects.length}</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>会话数量</CardTitle>
							<CardDescription>归属这些项目的未删除会话。</CardDescription>
						</CardHeader>
						<CardContent>
							<p className="text-3xl font-semibold">{totalSessions}</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>快捷入口</CardTitle>
							<CardDescription>进入聊天页继续使用项目。</CardDescription>
						</CardHeader>
						<CardContent>
							<Link to="/chat" className={buttonVariants({ variant: "outline" })}>
								<MessageSquareIcon data-icon="inline-start" />
								打开 Chat
							</Link>
						</CardContent>
					</Card>
				</div>

				{error ? (
					<Alert variant="destructive">
						<AlertTitle>操作失败</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<Card>
					<CardHeader>
						<CardTitle>项目列表</CardTitle>
						<CardDescription>删除项目会同步移除它下面的聊天会话。</CardDescription>
					</CardHeader>
					<CardContent>
						{isLoading ? (
							<div className="flex flex-col gap-2">
								<Skeleton className="h-10" />
								<Skeleton className="h-10" />
								<Skeleton className="h-10" />
							</div>
						) : projects.length === 0 ? (
							<div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
								还没有项目，先新建一个项目。
							</div>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>名称</TableHead>
										<TableHead>描述</TableHead>
										<TableHead>会话</TableHead>
										<TableHead>更新时间</TableHead>
										<TableHead className="text-right">操作</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{projects.map((project) => (
										<TableRow key={project.id}>
											<TableCell className="max-w-48">
												<div className="flex min-w-0 flex-col gap-1">
													<span className="truncate font-medium">{project.name}</span>
													<span className="truncate text-xs text-muted-foreground">
														{project.id}
													</span>
												</div>
											</TableCell>
											<TableCell className="max-w-72">
												<span className="block truncate text-muted-foreground">
													{project.description || "无描述"}
												</span>
											</TableCell>
											<TableCell>{project._count?.sessions ?? 0}</TableCell>
											<TableCell>{formatDateTime(project.updatedAt)}</TableCell>
											<TableCell>
												<div className="flex justify-end gap-2">
													<Button
														variant="outline"
														size="sm"
														onClick={() => openEditDialog(project)}
													>
														<Edit3Icon data-icon="inline-start" />
														编辑
													</Button>
													<Button
														variant="outline"
														size="sm"
														onClick={() => setDeletingProject(project)}
													>
														<Trash2Icon data-icon="inline-start" />
														删除
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			</section>

			<Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
				<DialogContent>
					<form className="flex flex-col gap-4" onSubmit={saveProject}>
						<DialogHeader>
							<DialogTitle>{editingProject ? "编辑项目" : "新建项目"}</DialogTitle>
							<DialogDescription>
								项目名称用于聊天页工作区切换，描述只在管理页展示。
							</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="project-name">项目名称</Label>
								<Input
									id="project-name"
									value={form.name}
									maxLength={80}
									placeholder="例如：产品研发"
									onChange={(event) =>
										setForm((current) => ({ ...current, name: event.target.value }))
									}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="project-description">项目描述</Label>
								<Textarea
									id="project-description"
									value={form.description}
									maxLength={500}
									placeholder="记录项目用途、边界或协作说明"
									onChange={(event) =>
										setForm((current) => ({
											...current,
											description: event.target.value,
										}))
									}
								/>
							</div>
						</div>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>
								取消
							</DialogClose>
							<Button type="submit" disabled={isSaving}>
								{isSaving ? <Loader2Icon data-icon="inline-start" /> : null}
								保存
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={Boolean(deletingProject)} onOpenChange={() => setDeletingProject(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除项目</DialogTitle>
							<DialogDescription>
								确认删除 `{deletingProject?.name}`？它下面的聊天会话也会同步移除，正在运行的会话会在后台停止。
							</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							取消
						</DialogClose>
						<Button variant="destructive" onClick={() => void deleteProject()} disabled={isDeleting}>
							{isDeleting ? <Loader2Icon data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}
