import { AlertCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
	"pdfjs-dist/build/pdf.worker.min.mjs",
	import.meta.url,
).toString();

/** PDF 预览属性。 */
interface WorkspacePdfPreviewProps {
	/** PDF 下载 URL。 */
	fileUrl: string;
}

/** PDF 渲染最大宽度，避免大屏下页面过宽影响阅读。 */
const PDF_PAGE_MAX_WIDTH = 920;

/** PDF 渲染最小宽度，保证窄面板仍可读。 */
const PDF_PAGE_MIN_WIDTH = 360;

/**
 * 计算 PDF page 渲染宽度。
 * @param containerWidth 预览容器宽度
 * @returns 页面宽度
 */
function getPdfPageWidth(containerWidth: number): number {
	return Math.max(PDF_PAGE_MIN_WIDTH, Math.min(containerWidth - 48, PDF_PAGE_MAX_WIDTH));
}

/**
 * 读取 PDF 加载成功后的页数。
 * @param payload react-pdf 回调参数
 * @returns 页数
 */
function readPdfPageCount(payload: { numPages?: number }): number {
	return typeof payload.numPages === "number" ? payload.numPages : 0;
}

/**
 * PDF 文件预览。
 * @param props 组件属性
 * @returns PDF 预览内容
 */
export function WorkspacePdfPreview(props: WorkspacePdfPreviewProps) {
	const { fileUrl } = props;
	const [numPages, setNumPages] = useState(0);
	const [pageWidth, setPageWidth] = useState(PDF_PAGE_MAX_WIDTH);
	const previewBodyRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const node = previewBodyRef.current;
		if (!node) {
			return;
		}
		// ResizeObserver 让 PDF 页面宽度跟随预览面板变化，不依赖固定断点。
		const observer = new ResizeObserver(([entry]) => {
			const width = entry?.contentRect.width ?? PDF_PAGE_MAX_WIDTH;
			setPageWidth(getPdfPageWidth(width));
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [fileUrl]);

	return (
		<div
			className="flex min-h-full justify-center bg-muted/30 p-6"
			ref={previewBodyRef}
		>
			<Document
				file={fileUrl}
				loading={null}
				error={<PdfPreviewError />}
				onLoadSuccess={(payload) => setNumPages(readPdfPageCount(payload))}
			>
				<div className="flex flex-col items-center gap-6">
					{Array.from({ length: numPages }, (_, index) => (
						<Page
							key={index + 1}
							pageNumber={index + 1}
							width={pageWidth}
							renderAnnotationLayer
							renderTextLayer
							className="overflow-hidden rounded-md bg-background shadow-sm"
						/>
					))}
				</div>
			</Document>
		</div>
	);
}

/**
 * PDF 加载失败提示。
 * @returns 错误状态
 */
function PdfPreviewError() {
	return (
		<Alert variant="destructive" className="max-w-md">
			<AlertCircleIcon />
			<AlertTitle>PDF 加载失败</AlertTitle>
			<AlertDescription>
				请确认文件仍存在于当前工作区，或使用右上角打开按钮直接查看下载地址。
			</AlertDescription>
		</Alert>
	);
}
