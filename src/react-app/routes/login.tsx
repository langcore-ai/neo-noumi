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
import { normalizeUsernameInput } from "@/lib/auth-identity";

export const Route = createFileRoute("/login")({
	component: LoginPage,
});

/**
 * 用户名密码登录页。
 * @returns 登录表单
 */
function LoginPage() {
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
		const result = await authClient.signIn.username({
			username,
			password,
		});

		setIsSubmitting(false);

		if (result.error) {
			setError(result.error.message || "登录失败，请检查用户名和密码。");
			return;
		}

		await navigate({ to: "/" });
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>登录账号</CardTitle>
					<CardDescription>使用用户名和密码登录。</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="grid gap-4" onSubmit={handleSubmit}>
						<div className="grid gap-2">
							<Label htmlFor="username">用户名</Label>
							<Input
								id="username"
								name="username"
								autoComplete="username"
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
								autoComplete="current-password"
								required
							/>
						</div>
						{error ? (
							<Alert variant="destructive">
								<AlertTitle>登录失败</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={isSubmitting}>
							{isSubmitting ? "登录中..." : "登录"}
						</Button>
						<Link
							to="/register"
							className={buttonVariants({ variant: "link", className: "w-fit px-0" })}
						>
							还没有账号，去注册
						</Link>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
