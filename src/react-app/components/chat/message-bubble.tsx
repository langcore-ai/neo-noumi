import { BotIcon, MoreHorizontalIcon, UserIcon, WrenchIcon } from "lucide-react";
import {
	Avatar,
	AvatarBadge,
	AvatarFallback,
} from "@/components/ui/avatar";
import { MarkdownContent } from "@/components/chat/markdown-content";
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
							<MarkdownContent content={message.content} />
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
