import { Hono } from "hono";
import { createAuth, type AuthBindings } from "./lib/auth";
import { mountCcrRoutes, type CcrBindings } from "./lib/ccr-routes";
export { ContainerProxy } from "@cloudflare/containers";
export { NeoNoumiSandbox } from "./lib/ccr-sandbox";

const app = new Hono<{
	Bindings: Env & AuthBindings & CcrBindings;
	Variables: { userId: string };
}>();

app.on(["GET", "POST"], "/api/auth/*", (c) => {
	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

mountCcrRoutes(app);

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

export default app;
