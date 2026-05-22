import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2Icon, MailIcon, SparklesIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/shadcn")({
	component: ShadcnShowcasePage,
});

/**
 * shadcn/ui 基础组件展示页。
 * @returns 常用组件的组合示例
 */
function ShadcnShowcasePage() {
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
				<header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
					<div className="space-y-3">
						<Badge variant="secondary" className="w-fit">
							Base UI shadcn
						</Badge>
						<div>
							<h1 className="text-3xl font-semibold tracking-normal">
								shadcn UI 组件示例
							</h1>
							<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
								集中展示项目已接入的常用组件，便于确认样式变量、交互状态和组合方式。
							</p>
						</div>
					</div>
					<Link to="/" className={buttonVariants({ variant: "outline" })}>
						返回首页
					</Link>
				</header>

				<section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
					<Card>
						<CardHeader>
							<CardTitle>按钮与状态</CardTitle>
							<CardDescription>常用操作按钮、徽标和禁用状态。</CardDescription>
							<CardAction>
								<Badge>Active</Badge>
							</CardAction>
						</CardHeader>
						<CardContent className="flex flex-wrap gap-3">
							<Button>Primary</Button>
							<Button variant="secondary">Secondary</Button>
							<Button variant="outline">Outline</Button>
							<Button variant="ghost">Ghost</Button>
							<Button variant="destructive">Delete</Button>
							<Button disabled>Disabled</Button>
						</CardContent>
						<CardFooter className="gap-2 text-sm text-muted-foreground">
							<CheckCircle2Icon className="size-4" />
							按钮来自 Base UI 版 shadcn 组件。
						</CardFooter>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>表单输入</CardTitle>
							<CardDescription>输入框、文本域和选择器的基础组合。</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-4">
							<div className="grid gap-2">
								<Label htmlFor="email">邮箱</Label>
								<div className="relative">
									<MailIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
									<Input id="email" className="pl-8" placeholder="team@example.com" />
								</div>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="role">角色</Label>
								<Select defaultValue="developer">
									<SelectTrigger id="role" className="w-full">
										<SelectValue placeholder="选择角色" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="owner">Owner</SelectItem>
										<SelectItem value="developer">Developer</SelectItem>
										<SelectItem value="viewer">Viewer</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="notes">备注</Label>
								<Textarea id="notes" placeholder="记录补充说明" />
							</div>
						</CardContent>
					</Card>
				</section>

				<section className="grid gap-4 lg:grid-cols-3">
					<Card>
						<CardHeader>
							<CardTitle>开关</CardTitle>
							<CardDescription>适合二元设置项。</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-4">
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="notifications">通知</Label>
								<Switch id="notifications" defaultChecked />
							</div>
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="compact">紧凑模式</Label>
								<Switch id="compact" size="sm" />
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>勾选项</CardTitle>
							<CardDescription>适合确认、筛选和批量选项。</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3">
							<label className="flex items-center gap-3 text-sm">
								<Checkbox defaultChecked />
								启用自动保存
							</label>
							<label className="flex items-center gap-3 text-sm">
								<Checkbox />
								同步到远端
							</label>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>分隔与提示</CardTitle>
							<CardDescription>用少量元素组织信息层级。</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="flex items-center gap-2">
								<SparklesIcon className="size-4 text-muted-foreground" />
								<span className="text-sm">组件已使用主题变量。</span>
							</div>
							<Separator />
							<div className="flex flex-wrap gap-2">
								<Badge variant="outline">Form</Badge>
								<Badge variant="secondary">Display</Badge>
								<Badge>Action</Badge>
							</div>
						</CardContent>
					</Card>
				</section>
			</div>
		</main>
	);
}
