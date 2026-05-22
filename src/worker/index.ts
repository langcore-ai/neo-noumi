import { Hono } from "hono";
import { createAuth, type AuthBindings } from "./lib/auth";

const app = new Hono<{ Bindings: Env & AuthBindings }>();

app.on(["GET", "POST"], "/api/auth/*", (c) => {
	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

export default app;
