import { AlertCircleIcon, DownloadIcon, FileIcon, FileTextIcon } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { WorkspaceMarkdownPreview } from "@/components/chat/workspace-markdown-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
	buildWorkspaceFileDownloadUrl,
	buildWorkspaceFileWriteUrl,
	isMarkdownWorkspaceFile,
	isPdfWorkspaceFile,
	type OpenFileTab,
} from "@/lib/workspace-model";

/** PDF 预览模块体积较大，只在打开 PDF 时加载。 */
const WorkspacePdfPreview = lazy(() =>
	import("@/components/chat/workspace-pdf-preview").then((module) => ({
		default: module.WorkspacePdfPreview,
	})),
);

/** 文件预览面板属性。 */
interface WorkspaceFilePreviewProps {
	/** 当前 project ID。 */
	projectId: string | null;
	/** 当前激活文件标签。 */
	file: OpenFileTab | null;
	/** 切换当前文件功能模式。 */
	onFileModeChange: (path: string, mode: OpenFileTab["mode"]) => void;
	/** 文件保存后回调。 */
	onFileSaved?: (path: string) => void | Promise<void>;
}

/**
 * workspace 文件预览面板。
 * @param props 组件属性
 * @returns 文件预览内容
 */
export function WorkspaceFilePreview(props: WorkspaceFilePreviewProps) {
	const { file, onFileModeChange, onFileSaved, projectId } = props;
	const downloadUrl = useMemo(() => {
		if (!projectId || !file) {
			return null;
		}
		return buildWorkspaceFileDownloadUrl(projectId, file.path, file.etag);
	}, [file, projectId]);
	const writeUrl = useMemo(() => {
		if (!projectId) {
			return null;
		}
		return buildWorkspaceFileWriteUrl(projectId);
	}, [projectId]);
	const isPdf = Boolean(file && isPdfWorkspaceFile(file.name || file.path));
	const isMarkdown = Boolean(file && isMarkdownWorkspaceFile(file.name || file.path));
	const effectiveMode = isPdf ? "preview" : file?.mode ?? "preview";

	if (!file || !downloadUrl) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-6">
				<div className="flex max-w-sm flex-col items-center gap-3 text-center">
					<div className="flex size-12 items-center justify-center rounded-full bg-muted">
						<FileIcon className="text-muted-foreground" />
					</div>
					<p className="text-sm text-muted-foreground">选择文件后在这里预览。</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<FileTextIcon className="shrink-0 text-muted-foreground" />
						<h2 className="truncate text-sm font-medium">{file.name}</h2>
					</div>
					<p className="truncate text-xs text-muted-foreground">{file.path}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Badge variant="outline">{effectiveMode === "edit" ? "编辑" : "预览"}</Badge>
					<Button
						variant="outline"
						size="sm"
						render={<a href={downloadUrl} target="_blank" rel="noreferrer" />}
					>
						<DownloadIcon data-icon="inline-start" />
						打开
					</Button>
				</div>
			</header>

			{isPdf ? (
				<ScrollArea className="min-h-0 flex-1">
					<Suspense fallback={<PdfPreviewLoading />}>
						<WorkspacePdfPreview key={downloadUrl} fileUrl={downloadUrl} />
					</Suspense>
				</ScrollArea>
			) : isMarkdown && writeUrl ? (
				<WorkspaceMarkdownPreview
					key={downloadUrl}
					downloadUrl={downloadUrl}
					writeUrl={writeUrl}
					path={file.path}
					mode={effectiveMode}
					onModeChange={(mode) => onFileModeChange(file.path, mode)}
					onSaved={onFileSaved}
				/>
			) : (
				<div className="flex min-h-0 flex-1 items-center justify-center p-6">
					<Alert className="max-w-md">
						<AlertCircleIcon />
						<AlertTitle>暂不支持预览该文件类型</AlertTitle>
						<AlertDescription>
							当前文件预览闭环先支持 PDF。其他文件类型会保留标签页和下载入口，编辑模式后续按格式单独接入。
						</AlertDescription>
					</Alert>
				</div>
			)}
		</div>
	);
}

/**
 * PDF 加载占位。
 * @returns 加载状态
 */
function PdfPreviewLoading() {
	return (
		<div className="flex w-full max-w-3xl flex-col gap-4">
			<Skeleton className="h-[640px] w-full" />
			<Skeleton className="h-[640px] w-full" />
		</div>
	);
}
