import { BotIcon, MoreHorizontalIcon, UserIcon, WrenchIcon } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	Avatar,
	AvatarBadge,
	AvatarFallback,
} from "@/components/ui/avatar";
import {
	type ChatMessage,
	getControlEventSummary,
	getToolUseSummary,
	type PayloadDataBubbleRendererProps,
	formatTime,
	isTimelineMessageChunk,
} from "@/lib/chat-message-model";
import { cn } from "@/lib/utils";

/** 默认折叠展示的运行事件类型。 */
const DEFAULT_COLLAPSED_TOOL_META_TYPES = [
	"system",
	"result",
	"thinking",
	"tool_use",
	"bash_progress",
	"control_request",
	"control_response",
];

/** Chat 气泡内 markdown 排版组件映射。 */
const CHAT_MARKDOWN_COMPONENTS: Components = {
	p: ({ children }) => <p className="leading-6">{children}</p>,
	h1: ({ children }) => (
		<h1 className="scroll-m-20 text-base font-semibold leading-7">
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className="scroll-m-20 text-sm font-semibold leading-6">
			{children}
		</h2>
	),
	h3: ({ children }) => (
		<h3 className="scroll-m-20 text-sm font-medium leading-6">
			{children}
		</h3>
	),
	h4: ({ children }) => (
		<h4 className="scroll-m-20 text-sm font-medium leading-6">
			{children}
		</h4>
	),
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	em: ({ children }) => <em className="italic">{children}</em>,
	a: ({ children, href }) => {
		const safeHref = readSafeMarkdownHref(href);
		if (!safeHref) {
			return <span>{children}</span>;
		}
		return (
			<a
				className="underline underline-offset-4 hover:opacity-80"
				href={safeHref}
				rel="noreferrer"
				target="_blank"
			>
				{children}
			</a>
		);
	},
	ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
	ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
	li: ({ children }) => <li className="pl-1">{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="border-l-2 border-border pl-3 text-muted-foreground italic">
			{children}
		</blockquote>
	),
	code: ({ children, className }) => {
		const isBlockCode = typeof className === "string" && className.startsWith("language-");
		if (isBlockCode) {
			return <code className={className}>{children}</code>;
		}
		return (
			<code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
				{children}
			</code>
		);
	},
	pre: ({ children }) => (
		<pre className="max-w-full overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
			{children}
		</pre>
	),
	table: ({ children }) => (
		<div className="max-w-full overflow-auto rounded-md border">
			<table className="w-full caption-bottom border-collapse text-left text-xs">
				{children}
			</table>
		</div>
	),
	th: ({ children }) => (
		<th className="border-b bg-muted px-2 py-1 font-medium text-foreground">
			{children}
		</th>
	),
	td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
	hr: () => <hr className="border-border" />,
};

/** 允许在 markdown 链接中打开的 URL 协议。 */
const ALLOWED_MARKDOWN_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

/**
 * 读取安全的 markdown 链接。
 * @param href markdown href
 * @returns 安全 href；危险协议返回 undefined
 */
function readSafeMarkdownHref(href: string | undefined) {
	if (!href) {
		return undefined;
	}
	try {
		const url = new URL(href, "https://neo-noumi.local");
		if (href.startsWith("/")) {
			return href;
		}
		return ALLOWED_MARKDOWN_LINK_PROTOCOLS.includes(url.protocol) ? href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Chat 气泡内 markdown 内容。
 * @param props 组件属性
 * @param props.content markdown 文本
 * @returns markdown 渲染结果
 */
function ChatMarkdownContent({ content }: { content: string }) {
	return (
		<div className="flex flex-col gap-2 whitespace-pre-wrap break-words">
			<ReactMarkdown
				components={CHAT_MARKDOWN_COMPONENTS}
				remarkPlugins={[remarkGfm]}
			>
				{content}
			</ReactMarkdown>
		</div>
	);
}

/**
 * payload.data.type 默认气泡组件。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
function GenericPayloadDataMessageBubble({ message }: PayloadDataBubbleRendererProps) {
	return <DefaultMessageBubble message={message} />;
}

/**
 * 单条聊天消息分发器。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
	if (message.payloadDataType && isTimelineMessageChunk(message.chunk)) {
		const payloadDataBubbleProps = {
			message,
			chunk: message.chunk,
			payloadDataType: message.payloadDataType,
		};
		switch (message.payloadDataType) {
			case "bash_progress":
				// 先显式保留分支；后续 bash_progress 可替换成独立组件。
				return <GenericPayloadDataMessageBubble {...payloadDataBubbleProps} />;
			default:
				// 未单独适配的 payload.data.type 暂时复用通用气泡。
				return <GenericPayloadDataMessageBubble {...payloadDataBubbleProps} />;
		}
	}
	return <DefaultMessageBubble message={message} />;
}

/**
 * 默认聊天消息气泡。
 * @param props 组件属性
 * @param props.message 页面消息
 * @returns 消息气泡
 */
function DefaultMessageBubble({ message }: { message: ChatMessage }) {
	const isUser = message.role === "user";
	const isTool = message.role === "tool";
	const isThinking = message.meta === "thinking";
	const isToolUse = message.meta === "tool_use";
	const isControlEvent =
		message.meta === "control_request" || message.meta === "control_response";
	const shouldRenderMarkdown = message.role === "assistant";
	const isCollapsedRawEvent =
		isTool &&
		DEFAULT_COLLAPSED_TOOL_META_TYPES.includes(message.meta ?? "");
	return (
		<article
			className={cn(
				"flex gap-3",
				isUser ? "justify-end" : "justify-start",
			)}
		>
			{!isUser ? (
				<Avatar className="mt-1">
					<AvatarFallback>{isTool ? <WrenchIcon /> : <BotIcon />}</AvatarFallback>
					{message.status === "streaming" ? <AvatarBadge /> : null}
				</Avatar>
			) : null}
			<div
				className={cn(
					"flex max-w-[82%] flex-col gap-2 rounded-xl px-4 py-3 text-sm",
					isUser
						? "bg-primary text-primary-foreground"
						: isTool
							? "border bg-muted/40 text-muted-foreground"
							: "border bg-card text-card-foreground",
				)}
			>
				<div className="flex items-center justify-between gap-3">
					<span className="text-xs font-medium">
						{isUser ? "你" : isTool ? message.meta || "运行事件" : "Neo Noumi"}
					</span>
					<span className="text-xs opacity-70">{formatTime(message.createdAt)}</span>
				</div>
				{isCollapsedRawEvent ? (
					<p className="text-xs text-muted-foreground">
						{isThinking
							? message.content
							: isToolUse
								? getToolUseSummary(message.raw)
								: isControlEvent
									? getControlEventSummary(message.raw, message.meta)
									: `原始事件状态：${message.status ?? "done"}`}
					</p>
				) : (
					<>
						{shouldRenderMarkdown ? (
							<ChatMarkdownContent content={message.content} />
						) : (
							<p className="whitespace-pre-wrap break-words leading-6">
								{message.content}
							</p>
						)}
					</>
				)}
				{message.raw && isTool ? (
					<details className="group">
						<summary className="flex cursor-pointer items-center gap-1 text-xs">
							<MoreHorizontalIcon />
							查看原始事件
						</summary>
						<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-background p-3 text-xs">
							{JSON.stringify(message.raw, null, 2)}
						</pre>
					</details>
				) : null}
			</div>
			{isUser ? (
				<Avatar className="mt-1">
					<AvatarFallback>
						<UserIcon />
					</AvatarFallback>
				</Avatar>
			) : null}
		</article>
	);
}
