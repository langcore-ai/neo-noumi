"use client";

import {
	AlertCircleIcon,
	FileArchiveIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FileUpIcon,
	HeadphonesIcon,
	ImageIcon,
	Loader2Icon,
	VideoIcon,
	XIcon,
} from "lucide-react";
import type { InputHTMLAttributes } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	formatBytes,
	type FileWithPreview,
	useFileUpload,
} from "@/hooks/use-file-upload";

/** 单次上传文件数量上限，避免一次表单提交过大。 */
const WORKSPACE_UPLOAD_MAX_FILES = 500;

/** 单文件大小上限，单位字节。 */
const WORKSPACE_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;

/** 浏览器文件夹上传携带的相对路径字段。 */
type FileWithDirectoryPath = File & {
	/** 文件夹选择时由浏览器写入的相对路径。 */
	webkitRelativePath?: string;
};

/** 工作区上传文件。 */
export type WorkspaceUploadFile = {
	/** 原始浏览器文件对象。 */
	file: File;
	/** 相对上传目标目录的路径。 */
	relativePath: string;
};

/** 工作区上传面板属性。 */
interface WorkspaceUploadPanelProps {
	/** 上传模式：普通文件或文件夹。 */
	mode: "files" | "directory";
	/** 上传目标目录名称。 */
	targetName: string;
	/** 是否禁用交互。 */
	disabled?: boolean;
	/** 提交上传。 */
	onUpload: (files: WorkspaceUploadFile[]) => Promise<void>;
}

/**
 * 获取文件图标。
 * @param file 上传文件包装对象
 * @returns 对应的文件类型图标
 */
function getFileIcon(file: { file: File | { type: string; name: string } }) {
	const fileType = file.file instanceof File ? file.file.type : file.file.type;
	const fileName = file.file instanceof File ? file.file.name : file.file.name;

	if (
		fileType.includes("pdf") ||
		fileName.endsWith(".pdf") ||
		fileType.includes("word") ||
		fileName.endsWith(".doc") ||
		fileName.endsWith(".docx")
	) {
		return <FileTextIcon className="size-4 opacity-60" />;
	}
	if (
		fileType.includes("zip") ||
		fileType.includes("archive") ||
		fileName.endsWith(".zip") ||
		fileName.endsWith(".rar")
	) {
		return <FileArchiveIcon className="size-4 opacity-60" />;
	}
	if (
		fileType.includes("excel") ||
		fileName.endsWith(".xls") ||
		fileName.endsWith(".xlsx")
	) {
		return <FileSpreadsheetIcon className="size-4 opacity-60" />;
	}
	if (fileType.includes("video/")) {
		return <VideoIcon className="size-4 opacity-60" />;
	}
	if (fileType.includes("audio/")) {
		return <HeadphonesIcon className="size-4 opacity-60" />;
	}
	if (fileType.startsWith("image/")) {
		return <ImageIcon className="size-4 opacity-60" />;
	}
	return <FileIcon className="size-4 opacity-60" />;
}

/**
 * 读取文件夹上传时应写入 workspace 的相对路径。
 * @param file 浏览器文件对象
 * @returns 相对目标目录的路径
 */
function getUploadRelativePath(file: File): string {
	const directoryFile = file as FileWithDirectoryPath;
	return directoryFile.webkitRelativePath || file.name;
}

/**
 * 把上传 hook 的文件列表转换成业务上传输入。
 * @param files 上传 hook 文件列表
 * @returns 可提交到 workspace API 的文件列表
 */
function toWorkspaceUploadFiles(files: FileWithPreview[]): WorkspaceUploadFile[] {
	return files.flatMap((item) => {
		if (!(item.file instanceof File)) {
			return [];
		}
		return [
			{
				file: item.file,
				relativePath: getUploadRelativePath(item.file),
			},
		];
	});
}

/**
 * 工作区上传面板。
 * @param props 组件属性
 * @returns 上传面板
 */
export default function WorkspaceUploadPanel({
	mode,
	targetName,
	disabled,
	onUpload,
}: WorkspaceUploadPanelProps) {
	const [isUploading, setIsUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [
		{ files, isDragging, errors },
		{
			handleDragEnter,
			handleDragLeave,
			handleDragOver,
			handleDrop,
			openFileDialog,
			removeFile,
			clearFiles,
			getInputProps,
		},
	] = useFileUpload({
		maxFiles: WORKSPACE_UPLOAD_MAX_FILES,
		maxSize: WORKSPACE_UPLOAD_MAX_SIZE,
		multiple: true,
	});
	const isDirectoryMode = mode === "directory";
	const inputProps = getInputProps({
		disabled: disabled || isUploading,
		// 文件夹上传需要浏览器私有属性，React 类型暂未覆盖。
		...(isDirectoryMode ? { webkitdirectory: "" } : {}),
	} as InputHTMLAttributes<HTMLInputElement>);
	const uploadableFiles = toWorkspaceUploadFiles(files);

	/**
	 * 提交当前选择的文件。
	 */
	async function submitUpload() {
		if (uploadableFiles.length === 0) {
			return;
		}
		setIsUploading(true);
		setUploadError(null);
		try {
			// 上传成功后清空本地选择，避免重复提交同一批文件。
			await onUpload(uploadableFiles);
			clearFiles();
		} catch (err) {
			setUploadError(err instanceof Error ? err.message : "上传失败");
		} finally {
			setIsUploading(false);
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<div
				className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-input border-dashed p-4 transition-colors hover:bg-accent/50 has-disabled:pointer-events-none has-[input:focus]:border-ring has-disabled:opacity-50 has-[input:focus]:ring-[3px] has-[input:focus]:ring-ring/50 data-[dragging=true]:bg-accent/50"
				data-dragging={isDragging || undefined}
				onClick={openFileDialog}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
				role="button"
				tabIndex={-1}
			>
				<input {...inputProps} aria-label="上传工作区文件" className="sr-only" />

				<div className="flex flex-col items-center justify-center text-center">
					<div
						aria-hidden="true"
						className="mb-2 flex size-11 shrink-0 items-center justify-center rounded-full border bg-background"
					>
						<FileUpIcon className="size-4 opacity-60" />
					</div>
					<p className="mb-1.5 text-sm font-medium">
						{isDirectoryMode ? "选择文件夹" : "上传文件"}
					</p>
					<p className="mb-2 text-muted-foreground text-xs">
						上传到 {targetName}，可拖拽文件或点击选择
					</p>
					<div className="flex flex-wrap justify-center gap-1 text-muted-foreground/70 text-xs">
						<span>最多 {WORKSPACE_UPLOAD_MAX_FILES} 个文件</span>
						<span>∙</span>
						<span>单文件 {formatBytes(WORKSPACE_UPLOAD_MAX_SIZE)}</span>
					</div>
				</div>
			</div>

			{errors.length > 0 ? (
				<div className="flex items-center gap-1 text-destructive text-xs" role="alert">
					<AlertCircleIcon className="size-3 shrink-0" />
					<span>{errors[0]}</span>
				</div>
			) : null}
			{uploadError ? (
				<div className="flex items-center gap-1 text-destructive text-xs" role="alert">
					<AlertCircleIcon className="size-3 shrink-0" />
					<span>{uploadError}</span>
				</div>
			) : null}

			{files.length > 0 ? (
				<div className="max-h-56 space-y-2 overflow-auto pr-1">
					{files.map((file) => (
						<div
							className="flex items-center justify-between gap-2 rounded-lg border bg-background p-2 pe-3"
							key={file.id}
						>
							<div className="flex min-w-0 items-center gap-3">
								<div className="flex aspect-square size-10 shrink-0 items-center justify-center rounded border">
									{getFileIcon(file)}
								</div>
								<div className="flex min-w-0 flex-col gap-0.5">
									<p className="truncate font-medium text-[13px]">
										{file.file instanceof File
											? getUploadRelativePath(file.file)
											: file.file.name}
									</p>
									<p className="text-muted-foreground text-xs">
										{formatBytes(file.file instanceof File ? file.file.size : file.file.size)}
									</p>
								</div>
							</div>

							<Button
								aria-label="移除文件"
								className="-me-2 size-8 text-muted-foreground/80 hover:bg-transparent hover:text-foreground"
								disabled={isUploading}
								onClick={() => removeFile(file.id)}
								size="icon"
								variant="ghost"
							>
								<XIcon aria-hidden="true" className="size-4" />
							</Button>
						</div>
					))}
				</div>
			) : null}

			<div className="flex items-center justify-between gap-2">
				<Button
					disabled={files.length === 0 || isUploading}
					onClick={clearFiles}
					size="sm"
					variant="outline"
				>
					清空
				</Button>
				<Button
					disabled={uploadableFiles.length === 0 || disabled || isUploading}
					onClick={() => void submitUpload()}
					size="sm"
				>
					{isUploading ? (
						<Loader2Icon data-icon="inline-start" className="animate-spin" />
					) : (
						<FileUpIcon data-icon="inline-start" />
					)}
					上传 {uploadableFiles.length || ""}
				</Button>
			</div>
		</div>
	);
}
