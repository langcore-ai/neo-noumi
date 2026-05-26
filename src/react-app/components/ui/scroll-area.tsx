import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import type { Ref, UIEventHandler } from "react"

import { cn } from "@/lib/utils"

/** 滚动区域组件属性。 */
interface ScrollAreaProps extends ScrollAreaPrimitive.Root.Props {
  /** Viewport 元素 ref，用于业务侧读取真实滚动位置。 */
  viewportRef?: Ref<HTMLDivElement>
  /** Viewport 附加样式。 */
  viewportClassName?: string
  /** Content 附加样式。 */
  contentClassName?: string
  /** Viewport 滚动事件。 */
  onViewportScroll?: UIEventHandler<HTMLDivElement>
}

function ScrollArea({
  className,
  children,
  contentClassName,
  onViewportScroll,
  viewportClassName,
  viewportRef,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName
        )}
        onScroll={onViewportScroll}
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          className={contentClassName}
          // Base UI 默认使用 fit-content；这里覆盖为 100%，避免纵向滚动区域内容宽度收缩。
          style={{ minWidth: "100%" }}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
