import { AlertCircleIcon, SaveIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

/** Markdown 文件加载状态。 */
type MarkdownLoadState =
	| { status: "loading"; content: ""; draft: ""; error: null }
	| { status: "loaded"; content: string; draft: string; error: null }
	| { status: "error"; content: ""; draft: ""; error: string };

/** Markdown 预览模式。 */
type MarkdownMode = "preview" | "edit";

/** Markdown 预览组件属性。 */
interface WorkspaceMarkdownPreviewProps {
	/** Markdown 下载 URL。 */
	downloadUrl: string;
	/** Markdown 写入 URL。 */
	writeUrl: string;
	/** workspace 文件路径。 */
	path: string;
	/** 当前展示模式。 */
	mode: MarkdownMode;
	/** 切换展示模式。 */
	onModeChange: (mode: MarkdownMode) => void;
	/** 保存后回调，用于刷新文件树元数据。 */
	onSaved?: (path: string) => void | Promise<void>;
}

/**
 * 读取失败响应文本。
 * @param response fetch 响应
 * @returns 错误文本
 */
async function readMarkdownError(response: Response): Promise<string> {
	const text = await response.text();
	return text || `HTTP ${response.status}`;
}

/**
 * Markdown 文件预览和编辑。
 * @param props 组件属性
 * @returns Markdown 预览/编辑内容
 */
export function WorkspaceMarkdownPreview(props: WorkspaceMarkdownPreviewProps) {
	const { downloadUrl, mode, onModeChange, onSaved, path, writeUrl } = props;
	const [loadState, setLoadState] = useState<MarkdownLoadState>({
		status: "loading",
		content: "",
		draft: "",
		error: null,
	});
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const isDirty = loadState.status === "loaded" && loadState.draft !== loadState.content;
	const previewContent = useMemo(() => {
		if (loadState.status !== "loaded") {
			return "";
		}
		// 编辑模式下的预览面板应该反映未保存草稿，便于左右切换核对。
		return loadState.draft;
	}, [loadState]);

	useEffect(() => {
		const controller = new AbortController();
		async function loadMarkdown() {
			try {
				const response = await fetch(downloadUrl, { signal: controller.signal });
				if (!response.ok) {
					throw new Error(await readMarkdownError(response));
				}
				const text = await response.text();
				setLoadState({ status: "loaded", content: text, draft: text, error: null });
			} catch (err) {
				if (controller.signal.aborted) {
					return;
				}
				setLoadState({
					status: "error",
					content: "",
					draft: "",
					error: err instanceof Error ? err.message : "Markdown 加载失败",
				});
			}
		}
		void loadMarkdown();
		return () => controller.abort();
	}, [downloadUrl]);

	/**
	 * 更新编辑草稿。
	 * @param draft 最新草稿
	 */
	function updateDraft(draft: string) {
		setLoadState((current) =>
			current.status === "loaded" ? { ...current, draft } : current,
		);
	}

	/** 保存 Markdown 内容。 */
	async function saveMarkdown() {
		if (loadState.status !== "loaded" || !isDirty) {
			return;
		}
		setIsSaving(true);
		setSaveError(null);
		try {
			const response = await fetch(writeUrl, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					path,
					content: loadState.draft,
					contentType: "text/markdown; charset=utf-8",
				}),
			});
			if (!response.ok) {
				throw new Error(await readMarkdownError(response));
			}
			setLoadState((current) =>
				current.status === "loaded"
					? { ...current, content: current.draft }
					: current,
			);
			await onSaved?.(path);
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : "Markdown 保存失败");
		} finally {
			setIsSaving(false);
		}
	}

	/**
	 * 切换 Markdown 展示模式。
	 * @param value Tabs 当前值
	 */
	function switchMode(value: string | number | null) {
		if (value === "preview" || value === "edit") {
			onModeChange(value);
		}
	}

	if (loadState.status === "loading") {
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
				<Skeleton className="h-8 w-44" />
				<Skeleton className="h-72 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (loadState.status === "error") {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-6">
				<Alert variant="destructive" className="max-w-md">
					<AlertCircleIcon />
					<AlertTitle>Markdown 加载失败</AlertTitle>
					<AlertDescription>{loadState.error}</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<Tabs value={mode} onValueChange={switchMode} className="min-h-0 flex-1 gap-0">
			<div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
				<TabsList>
					<TabsTrigger value="preview">预览</TabsTrigger>
					<TabsTrigger value="edit">编辑</TabsTrigger>
				</TabsList>
				<div className="flex items-center gap-2">
					{isDirty ? (
						<span className="text-xs text-muted-foreground">有未保存修改</span>
					) : null}
					<Button
						variant="outline"
						size="sm"
						disabled={!isDirty || isSaving}
						onClick={() => void saveMarkdown()}
					>
						<SaveIcon data-icon="inline-start" />
						{isSaving ? "保存中" : "保存"}
					</Button>
				</div>
			</div>
			{saveError ? (
				<Alert variant="destructive" className="m-4">
					<AlertCircleIcon />
					<AlertTitle>Markdown 保存失败</AlertTitle>
					<AlertDescription>{saveError}</AlertDescription>
				</Alert>
			) : null}
			<TabsContent value="preview" className="min-h-0 overflow-hidden">
				<ScrollArea className="h-full">
					<div className="mx-auto w-full max-w-4xl p-6">
						<MarkdownContent content={previewContent} />
					</div>
				</ScrollArea>
			</TabsContent>
			<TabsContent value="edit" className="min-h-0 p-4">
				<Textarea
					className="h-full min-h-full resize-none font-mono text-sm leading-6"
					value={loadState.draft}
					onChange={(event) => updateDraft(event.target.value)}
					spellCheck={false}
				/>
			</TabsContent>
		</Tabs>
	);
}
