import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** 允许在 markdown 链接中打开的 URL 协议。 */
const ALLOWED_MARKDOWN_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

/** 通用 markdown 排版组件映射。 */
const MARKDOWN_COMPONENTS: Components = {
	p: ({ children }) => <p className="leading-6">{children}</p>,
	h1: ({ children }) => (
		<h1 className="scroll-m-20 text-base font-semibold leading-7">{children}</h1>
	),
	h2: ({ children }) => (
		<h2 className="scroll-m-20 text-sm font-semibold leading-6">{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className="scroll-m-20 text-sm font-medium leading-6">{children}</h3>
	),
	h4: ({ children }) => (
		<h4 className="scroll-m-20 text-sm font-medium leading-6">{children}</h4>
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
	ul: ({ children }) => <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>,
	ol: ({ children }) => <ol className="flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
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
 * 通用 markdown 内容。
 * @param props 组件属性
 * @param props.content markdown 文本
 * @param props.className 外层样式
 * @returns markdown 渲染结果
 */
export function MarkdownContent({
	content,
	className,
}: {
	content: string;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col gap-2 whitespace-pre-wrap break-words", className)}>
			<ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]}>
				{content}
			</ReactMarkdown>
		</div>
	);
}
