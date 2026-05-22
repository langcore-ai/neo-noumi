import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
	// 通过官方 Vite 插件接入 Tailwind，避免额外维护 PostCSS 配置
	plugins: [react(), cloudflare(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src/react-app"),
		},
	},
});
