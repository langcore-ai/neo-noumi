import { createFileRoute, Link } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import {
	CircleIcon,
	FolderTreeIcon,
	Loader2Icon,
	TerminalIcon,
	Trash2Icon,
	UnplugIcon,
} from "lucide-react";
import { SandboxAddon, type ConnectionState } from "@cloudflare/sandbox/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/container")({
	component: ContainerPage,
});

/** 预连接阶段允许缓存的最大首条命令长度。 */
const MAX_PRECONNECT_COMMAND_LENGTH = 4096;

/** 终端连接状态展示文案。 */
const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
	connected: "已连接",
	connecting: "连接中",
	disconnected: "已断开",
};

/**
 * 生成当前页面使用的 WebSocket URL。
 * @param origin 当前页面对应的 ws/wss origin
 * @returns 后端终端代理地址
 */
function buildTerminalWebSocketUrl(origin: string): string {
	return `${origin}/api/container/terminal`;
}

/**
 * 判断终端输入是否为可本地回显的普通字符。
 * @param value xterm 输入片段
 * @returns 是否可直接追加到预连接命令
 */
function isPrintableInput(value: string): boolean {
	return [...value].every((char) => {
		const code = char.charCodeAt(0);
		// 只允许普通可见字符进入本地首条命令缓冲，控制键由上层分支单独处理。
		return code >= 0x20 && code !== 0x7f;
	});
}

/**
 * 读取终端状态 badge 文案。
 * @param state WebSocket 连接状态
 * @param hasStarted 是否已经尝试连接过容器
 * @returns 展示文案
 */
function getTerminalStatusLabel(state: ConnectionState, hasStarted: boolean): string {
	if (!hasStarted && state === "disconnected") {
		return "待输入";
	}
	return CONNECTION_STATE_LABELS[state];
}

/**
 * 写入前端本地的预连接提示。
 * @param terminal xterm 实例
 */
function writePreconnectPrompt(terminal: Terminal) {
	terminal.writeln("Neo Noumi Container Console");
	terminal.writeln("Type a command and press Enter to wake the container.");
	terminal.write("\r\n$ ");
}

/**
 * 容器管理页。
 * @returns 类终端容器控制页面
 */
function ContainerPage() {
	const authSession = authClient.useSession();
	const isAuthenticated = Boolean(authSession.data);
	const terminalHostRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const sandboxAddonRef = useRef<SandboxAddon | null>(null);
	const preconnectDisposableRef = useRef<IDisposable | null>(null);
	const preconnectInputRef = useRef("");
	const pendingFirstCommandRef = useRef<string | null>(null);
	const connectionStateRef = useRef<ConnectionState>("disconnected");
	const [connectionState, setConnectionState] =
		useState<ConnectionState>("disconnected");
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [hasStarted, setHasStarted] = useState(false);

	/**
	 * 同步终端连接状态。
	 * @param state 新连接状态
	 * @param error 可选错误
	 */
	const handleConnectionStateChange = useCallback((state: ConnectionState, error?: Error) => {
		connectionStateRef.current = state;
		setConnectionState(state);
		if (error) {
			setConnectionError(error.message);
		} else if (state !== "disconnected") {
			setConnectionError(null);
		}
		if (state === "connected" && pendingFirstCommandRef.current) {
			const command = pendingFirstCommandRef.current;
			pendingFirstCommandRef.current = null;
			// ready 控制帧到达后再把首条命令交给 PTY，确保不会被连接阶段吞掉。
			window.setTimeout(() => {
				terminalRef.current?.input(`${command}\r`, false);
			}, 40);
		}
	}, []);

	/**
	 * 建立终端 WebSocket。
	 * @param firstCommand 可选首条命令；连接成功后自动发送
	 */
	const connectTerminal = useCallback((firstCommand?: string) => {
		const terminal = terminalRef.current;
		const sandboxAddon = sandboxAddonRef.current;
		if (!terminal || !sandboxAddon || connectionStateRef.current === "connecting") {
			return;
		}
		setHasStarted(true);
		setConnectionError(null);
		preconnectDisposableRef.current?.dispose();
		preconnectDisposableRef.current = null;
		if (firstCommand) {
			pendingFirstCommandRef.current = firstCommand;
			terminal.write("\r\n\u001b[2mconnecting to container...\u001b[0m\r\n");
		}
		// sandboxId 只用于前端 addon 的目标标识，后端会从登录态重新派生真实 sandbox ID。
		sandboxAddon.connect({ sandboxId: "current-user" });
	}, []);

	/**
	 * 处理容器唤醒前的本地输入。
	 * @param data xterm 输入数据
	 */
	const handlePreconnectInput = useCallback((data: string) => {
		const terminal = terminalRef.current;
		if (!terminal || connectionStateRef.current !== "disconnected") {
			return;
		}

		for (const char of data) {
			if (char === "\r") {
				const command = preconnectInputRef.current;
				preconnectInputRef.current = "";
				if (command.trim().length === 0) {
					terminal.write("\r\n$ ");
					continue;
				}
				connectTerminal(command);
				return;
			}
			if (char === "\u0003") {
				preconnectInputRef.current = "";
				terminal.write("^C\r\n$ ");
				continue;
			}
			if (char === "\u007F") {
				if (preconnectInputRef.current.length > 0) {
					preconnectInputRef.current = preconnectInputRef.current.slice(0, -1);
					terminal.write("\b \b");
				}
				continue;
			}
			if (
				isPrintableInput(char) &&
				preconnectInputRef.current.length < MAX_PRECONNECT_COMMAND_LENGTH
			) {
				preconnectInputRef.current += char;
				terminal.write(char);
			}
		}
	}, [connectTerminal]);

	/**
	 * 清空终端显示内容。
	 */
	const clearTerminal = useCallback(() => {
		terminalRef.current?.clear();
	}, []);

	/**
	 * 断开浏览器终端连接。
	 */
	const disconnectTerminal = useCallback(() => {
		sandboxAddonRef.current?.disconnect();
	}, []);

	useEffect(() => {
		const host = terminalHostRef.current;
		if (!host || authSession.isPending || !isAuthenticated) {
			return;
		}

		const terminal = new Terminal({
			allowProposedApi: false,
			convertEol: true,
			cursorBlink: true,
			fontFamily:
				'"Geist Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			lineHeight: 1.25,
			scrollback: 10_000,
			theme: {
				background: "#05070a",
				black: "#0b0f14",
				blue: "#68a3ff",
				brightBlack: "#5b6472",
				brightBlue: "#8bb8ff",
				brightCyan: "#8be9fd",
				brightGreen: "#9be564",
				brightMagenta: "#d5a3ff",
				brightRed: "#ff7b86",
				brightWhite: "#ffffff",
				brightYellow: "#ffd166",
				cursor: "#f8fafc",
				cyan: "#56c7d8",
				foreground: "#e6edf3",
				green: "#73d13d",
				magenta: "#c084fc",
				red: "#ff5f66",
				selectionBackground: "#334155",
				white: "#d7dde6",
				yellow: "#f6c177",
			},
		});
		const fitAddon = new FitAddon();
		const sandboxAddon = new SandboxAddon({
			getWebSocketUrl: ({ origin }) => buildTerminalWebSocketUrl(origin),
			onStateChange: handleConnectionStateChange,
			reconnect: false,
		});
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(sandboxAddon);
		terminal.open(host);
		terminalRef.current = terminal;
		fitAddonRef.current = fitAddon;
		sandboxAddonRef.current = sandboxAddon;
		writePreconnectPrompt(terminal);
		preconnectDisposableRef.current = terminal.onData(handlePreconnectInput);

		const fitTerminal = () => {
			window.requestAnimationFrame(() => fitAddon.fit());
		};
		const resizeObserver = new ResizeObserver(fitTerminal);
		resizeObserver.observe(host);
		fitTerminal();
		terminal.focus();

		return () => {
			resizeObserver.disconnect();
			preconnectDisposableRef.current?.dispose();
			sandboxAddon.dispose();
			fitAddon.dispose();
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			sandboxAddonRef.current = null;
			preconnectDisposableRef.current = null;
		};
	}, [
		authSession.isPending,
		handleConnectionStateChange,
		handlePreconnectInput,
		isAuthenticated,
	]);

	if (authSession.isPending) {
		return (
			<main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
				<Badge variant="outline">
					<Loader2Icon className="animate-spin" data-icon="inline-start" />
					加载会话
				</Badge>
			</main>
		);
	}

	if (!authSession.data) {
		return (
			<main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>需要登录</CardTitle>
						<CardDescription>登录后才能打开自己的容器控制台。</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<Link to="/login" className={buttonVariants({ className: "w-full" })}>
							去登录
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
		<main className="flex h-screen min-h-[620px] overflow-hidden bg-background text-foreground">
			<aside className="hidden w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
				<div className="flex h-14 items-center gap-2 border-b px-4">
					<FolderTreeIcon className="size-4" />
					<span className="text-sm font-medium">Workspace</span>
				</div>
				<div className="flex flex-1 flex-col gap-3 p-4">
					<div className="rounded-md border border-dashed bg-background/60 p-4">
						<p className="text-sm font-medium">文件树占位</p>
						<p className="mt-2 text-sm text-muted-foreground">
							后续接入容器文件树后会在这里展示目录结构。
						</p>
					</div>
				</div>
			</aside>

			<section className="flex min-w-0 flex-1 flex-col">
				<header className="flex min-h-14 flex-col gap-3 border-b px-4 py-3 md:flex-row md:items-center md:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						<div className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
							<TerminalIcon className="size-4" />
						</div>
						<div className="min-w-0">
							<h1 className="truncate text-base font-semibold">容器控制台</h1>
							<p className="truncate text-sm text-muted-foreground">
								首条命令回车后才会连接并唤醒容器
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant={connectionState === "connected" ? "default" : "outline"}>
							<CircleIcon
								className={
									connectionState === "connecting"
										? "animate-pulse"
										: connectionState === "connected"
											? "fill-current"
											: ""
								}
								data-icon="inline-start"
							/>
							{getTerminalStatusLabel(connectionState, hasStarted)}
						</Badge>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => connectTerminal()}
							disabled={connectionState !== "disconnected"}
						>
							<TerminalIcon data-icon="inline-start" />
							重连
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={disconnectTerminal}
							disabled={connectionState === "disconnected"}
						>
							<UnplugIcon data-icon="inline-start" />
							断开
						</Button>
						<Button type="button" variant="outline" size="sm" onClick={clearTerminal}>
							<Trash2Icon data-icon="inline-start" />
							清屏
						</Button>
					</div>
				</header>

				{connectionError ? (
					<div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
						{connectionError}
					</div>
				) : null}

				<div className="min-h-0 flex-1 bg-[#05070a] p-2 md:p-4">
					<div
						ref={terminalHostRef}
						className="h-full min-h-[420px] overflow-hidden rounded-md border border-white/10 bg-[#05070a]"
						onClick={() => terminalRef.current?.focus()}
					/>
				</div>
			</section>
		</main>
	);
}
