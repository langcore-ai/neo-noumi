// src/App.tsx

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import cloudflareLogo from "./assets/Cloudflare_Logo.svg";
import honoLogo from "./assets/hono.svg";

function App() {
	const [count, setCount] = useState(0);
	const [name, setName] = useState("unknown");

	return (
		<div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-6 py-16 text-center text-white">
			<div className="flex flex-wrap items-center justify-center gap-4">
				<a href="https://vite.dev" target="_blank">
					<img src={viteLogo} className="logo" alt="Vite logo" />
				</a>
				<a href="https://react.dev" target="_blank">
					<img src={reactLogo} className="logo react" alt="React logo" />
				</a>
				<a href="https://hono.dev/" target="_blank">
					<img src={honoLogo} className="logo cloudflare" alt="Hono logo" />
				</a>
				<a href="https://workers.cloudflare.com/" target="_blank">
					<img
						src={cloudflareLogo}
						className="logo cloudflare"
						alt="Cloudflare logo"
					/>
				</a>
			</div>
			<h1 className="mt-8 text-5xl font-semibold tracking-tight">
				Vite + React + Hono + Cloudflare
			</h1>
			<div className="card rounded-2xl border border-white/10 bg-white/5 shadow-lg shadow-black/20 backdrop-blur">
				<Button
					onClick={() => setCount((count) => count + 1)}
					aria-label="increment"
				>
					count is {count}
				</Button>
				<p>
					Edit <code>src/App.tsx</code> and save to test HMR
				</p>
			</div>
			<div className="card rounded-2xl border border-white/10 bg-white/5 shadow-lg shadow-black/20 backdrop-blur">
				<Button
					onClick={() => {
						fetch("/api/")
							.then((res) => res.json() as Promise<{ name: string }>)
							.then((data) => setName(data.name));
					}}
					aria-label="get name"
				>
					Name from API is: {name}
				</Button>
				<p>
					Edit <code>worker/index.ts</code> to change the name
				</p>
			</div>
			<p className="read-the-docs mt-6 text-sm text-white/60">
				Click on the logos to learn more
			</p>
			<div className="mt-6 flex flex-wrap justify-center gap-3">
				<Link to="/login" className={buttonVariants({ variant: "outline" })}>
					登录
				</Link>
				<Link to="/register" className={buttonVariants()}>
					注册
				</Link>
				<Link to="/shadcn" className={buttonVariants({ variant: "outline" })}>
					查看 shadcn 组件示例
				</Link>
			</div>
		</div>
	);
}

export default App;
