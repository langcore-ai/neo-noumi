import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
	component: RootLayout,
});

/**
 * 应用根路由布局。
 * @returns 路由出口与开发调试工具
 */
function RootLayout() {
	return (
		<TooltipProvider>
			<Outlet />
			<TanStackRouterDevtools position="bottom-right" />
		</TooltipProvider>
	);
}
