import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
	// Prisma schema 固定放在 prisma 目录下，保持与默认迁移目录一致
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		// Prisma CLI 在本地通过 .env 读取数据库连接串
		url: env("DATABASE_URL"),
	},
});
