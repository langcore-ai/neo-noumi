import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { authClient } from "@/lib/auth-client";
import { createInternalEmail, normalizeUsernameInput } from "@/lib/auth-identity";

export const Route = createFileRoute("/register")({
	component: RegisterPage,
});

/**
 * 用户名密码注册页。
 * @returns 注册表单
 */
function RegisterPage() {
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setIsSubmitting(true);

		const formData = new FormData(event.currentTarget);
		const username = normalizeUsernameInput(String(formData.get("username") ?? ""));
		const password = String(formData.get("password") ?? "");
		const name = String(formData.get("name") || username);

		const result = await authClient.signUp.email({
			email: createInternalEmail(username),
			name,
			password,
			username,
			displayUsername: username,
		});

		setIsSubmitting(false);

		if (result.error) {
			setError(result.error.message || "注册失败，请检查用户名和密码。");
			return;
		}

		await navigate({ to: "/" });
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>注册账号</CardTitle>
					<CardDescription>使用用户名和密码创建本地账号。</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="grid gap-4" onSubmit={handleSubmit}>
						<div className="grid gap-2">
							<Label htmlFor="name">显示名称</Label>
							<Input id="name" name="name" placeholder="Neo Noumi" />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="username">用户名</Label>
							<Input
								id="username"
								name="username"
								autoComplete="username"
								minLength={3}
								placeholder="neo_noumi"
								required
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="password">密码</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="new-password"
								minLength={8}
								required
							/>
						</div>
						{error ? (
							<Alert variant="destructive">
								<AlertTitle>注册失败</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={isSubmitting}>
							{isSubmitting ? "注册中..." : "注册"}
						</Button>
						<Link
							to="/login"
							className={buttonVariants({ variant: "link", className: "w-fit px-0" })}
						>
							已有账号，去登录
						</Link>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
