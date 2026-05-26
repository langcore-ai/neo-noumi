import { Link } from "@tanstack/react-router";
import {
	ArrowRightIcon,
	BoxesIcon,
	CheckCircle2Icon,
	CloudIcon,
	FolderKanbanIcon,
	HomeIcon,
	MessageSquareIcon,
	RefreshCwIcon,
	ShieldIcon,
	SparklesIcon,
	UserPlusIcon,
} from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth-client";

/** 首页展示的功能入口。 */
const FEATURE_LINKS = [
	{
		title: "账号登录",
		description: "验证认证页面和会话入口是否可用。",
		to: "/login",
		icon: ShieldIcon,
		variant: "outline" as const,
	},
	{
		title: "新用户注册",
		description: "检查注册流程与基础表单样式。",
		to: "/register",
		icon: UserPlusIcon,
		variant: "default" as const,
	},
	{
		title: "组件示例",
		description: "查看 shadcn 组件在当前主题下的表现。",
		to: "/shadcn",
		icon: SparklesIcon,
		variant: "outline" as const,
	},
	{
		title: "CCR Chat",
		description: "进入容器会话与事件流测试页面。",
		to: "/chat",
		icon: MessageSquareIcon,
		variant: "outline" as const,
	},
	{
		title: "Project 管理",
		description: "维护聊天工作区和会话分组。",
		to: "/projects",
		icon: FolderKanbanIcon,
		variant: "outline" as const,
	},
];

/** 首页展示的技术栈检查项。 */
const STACK_ITEMS = [
	{ label: "React Router", value: "路由已挂载" },
	{ label: "shadcn/ui", value: "主题变量已加载" },
	{ label: "Cloudflare Worker", value: "通过 API 按钮验证" },
];

/** 首页顶部主导航。 */
const NAV_ITEMS = [
	{ label: "首页", to: "/", icon: HomeIcon },
	{ label: "Project", to: "/projects", icon: FolderKanbanIcon },
] as const;

/**
 * 测试首页。
 * @returns 测试入口聚合页面
 */
function App() {
	const currentSession = authClient.useSession();
	const [name, setName] = useState("unknown");
	const [apiStatus, setApiStatus] = useState<"idle" | "loading" | "ready" | "error">(
		"idle",
	);

	/**
	 * 调用后端测试接口，确认前端到 Worker 的基础链路。
	 */
	async function loadApiName() {
		setApiStatus("loading");
		try {
			const response = await fetch("/api/");

			// 非 2xx 响应也视为链路异常，避免页面展示过期状态。
			if (!response.ok) {
				throw new Error(response.statusText);
			}

			const data = (await response.json()) as { name: string };
			setName(data.name);
			setApiStatus("ready");
		} catch {
			setApiStatus("error");
		}
	}

	const session = currentSession.data?.session;
	const user = currentSession.data?.user;

	return (
		<main className="min-h-screen bg-background text-foreground">
			<section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6 md:py-8">
				<nav className="flex min-h-14 flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between">
					<Link to="/" className="flex w-fit items-center gap-2 font-semibold">
						<CloudIcon className="size-5" />
						Neo Noumi
					</Link>
					<div className="flex flex-wrap items-center gap-2">
						{NAV_ITEMS.map((item) => {
							const Icon = item.icon;

							return (
								<Link
									key={item.to}
									to={item.to}
									activeOptions={{ exact: item.to === "/" }}
									activeProps={{
										className: "bg-primary text-primary-foreground",
									}}
									inactiveProps={{
										className: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
									}}
									className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors"
								>
									<Icon className="size-4" />
									{item.label}
								</Link>
							);
						})}
					</div>
				</nav>
				<header className="flex flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground shadow-sm md:p-8">
					<div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
						<div className="flex max-w-3xl flex-col gap-4">
							<Badge variant="secondary" className="w-fit">
								<CloudIcon data-icon="inline-start" />
								Neo Noumi 测试入口
							</Badge>
							<div className="flex flex-col gap-3">
								<h1 className="text-3xl font-semibold leading-tight md:text-5xl">
									测试首页
								</h1>
								<p className="max-w-2xl text-base text-muted-foreground md:text-lg">
									用于快速检查前端路由、认证页面、组件主题和 Worker
									接口链路。
								</p>
							</div>
						</div>
						<Button onClick={loadApiName} disabled={apiStatus === "loading"}>
							<CloudIcon data-icon="inline-start" />
							{apiStatus === "loading" ? "检查中" : "检查 API"}
						</Button>
					</div>

					<Separator />

					<div className="grid gap-3 md:grid-cols-3">
						{STACK_ITEMS.map((item) => (
							<div key={item.label} className="flex flex-col gap-1">
								<span className="text-sm font-medium">{item.label}</span>
								<span className="text-sm text-muted-foreground">
									{item.value}
								</span>
							</div>
						))}
					</div>
				</header>

				<div className="grid gap-4 md:grid-cols-[1fr_320px]">
					<section className="grid gap-4 sm:grid-cols-2">
						{FEATURE_LINKS.map((item) => {
							const Icon = item.icon;

							return (
								<Card key={item.to}>
									<CardHeader>
										<CardTitle className="flex items-center gap-2">
											<Icon />
											{item.title}
										</CardTitle>
										<CardDescription>{item.description}</CardDescription>
									</CardHeader>
									<CardContent>
										<Link
											to={item.to}
											className={buttonVariants({
												variant: item.variant,
												className: "w-full",
											})}
										>
											打开
											<ArrowRightIcon data-icon="inline-end" />
										</Link>
									</CardContent>
								</Card>
							);
						})}
					</section>

					<aside className="flex flex-col gap-4">
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<CheckCircle2Icon />
									API 状态
								</CardTitle>
								<CardDescription>读取 `/api/` 返回的名称。</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								<div className="rounded-lg border bg-muted/40 p-3">
									<p className="text-sm text-muted-foreground">当前返回</p>
									<p className="mt-1 text-lg font-medium">{name}</p>
								</div>
								<Badge
									variant={apiStatus === "error" ? "destructive" : "outline"}
									className="w-fit"
								>
									{apiStatus === "ready"
										? "接口正常"
										: apiStatus === "error"
											? "接口异常"
											: "等待检查"}
								</Badge>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<ShieldIcon />
									登录会话
								</CardTitle>
								<CardDescription>读取当前浏览器的认证状态。</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{currentSession.isPending ? (
									<Badge variant="outline" className="w-fit">
										加载中
									</Badge>
								) : currentSession.error ? (
									<Badge variant="destructive" className="w-fit">
										会话读取失败
									</Badge>
								) : session && user ? (
									<div className="flex flex-col gap-3">
										<div className="rounded-lg border bg-muted/40 p-3">
											<p className="text-sm text-muted-foreground">当前用户</p>
											<p className="mt-1 text-base font-medium">
												{user.name || user.email}
											</p>
											<p className="mt-1 break-all text-sm text-muted-foreground">
												{user.email}
											</p>
										</div>
										<div className="grid gap-2 text-sm">
											<div className="flex items-center justify-between gap-3">
												<span className="text-muted-foreground">用户 ID</span>
												<span className="truncate font-medium">{user.id}</span>
											</div>
											<div className="flex items-center justify-between gap-3">
												<span className="text-muted-foreground">Session ID</span>
												<span className="truncate font-medium">{session.id}</span>
											</div>
											<div className="flex items-center justify-between gap-3">
												<span className="text-muted-foreground">过期时间</span>
												<span className="font-medium">
													{new Date(session.expiresAt).toLocaleString()}
												</span>
											</div>
										</div>
										<Badge variant="secondary" className="w-fit">
											已登录
										</Badge>
									</div>
								) : (
									<div className="flex flex-col gap-3">
										<Badge variant="outline" className="w-fit">
											未登录
										</Badge>
										<Link
											to="/login"
											className={buttonVariants({
												variant: "outline",
												className: "w-full",
											})}
										>
											去登录
											<ArrowRightIcon data-icon="inline-end" />
										</Link>
									</div>
								)}
								<Button
									variant="outline"
									onClick={() => currentSession.refetch()}
									disabled={currentSession.isPending || currentSession.isRefetching}
								>
									<RefreshCwIcon data-icon="inline-start" />
									{currentSession.isRefetching ? "刷新中" : "刷新会话"}
								</Button>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<BoxesIcon />
									验证范围
								</CardTitle>
								<CardDescription>首页只负责测试入口聚合。</CardDescription>
							</CardHeader>
							<CardContent>
								<ul className="flex flex-col gap-2 text-sm text-muted-foreground">
									<li>保留现有路由和页面语义。</li>
									<li>不修改认证、CCR 或 Worker 业务逻辑。</li>
									<li>使用现有 shadcn 组件和主题变量。</li>
								</ul>
							</CardContent>
						</Card>
					</aside>
				</div>
			</section>
		</main>
	);
}

export default App;
