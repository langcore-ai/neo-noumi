import { Hono } from "hono";
import { serve } from "bun";
import { cpus, loadavg, totalmem, freemem, uptime } from "node:os";

/** 观测服务监听端口；1024 以上避免和 Sandbox SDK 控制端口 3000 冲突。 */
const PORT = Number.parseInt(process.env.NEO_NOUMI_OBSERVER_PORT ?? "8080", 10);

/** 观测事件发送目标；由 Worker outbound handler 拦截并写入 PostgreSQL。 */
const OBSERVABILITY_ENDPOINT =
	process.env.NEO_NOUMI_OBSERVABILITY_ENDPOINT ??
	"http://neo-noumi-observability.internal/events";

/** 心跳周期，单位毫秒；默认 30 秒，避免给 Worker/PG 带来高频写入压力。 */
const HEARTBEAT_INTERVAL_MS = Number.parseInt(
	process.env.NEO_NOUMI_OBSERVER_HEARTBEAT_INTERVAL_MS ?? "30000",
	10,
);

/** Cloudflare shutdown 会先发 SIGTERM，进程需要在退出前尽量补一条信号事件。 */
const OBSERVED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const;

/** 观测事件类型。 */
type ObservationEventType =
	| "startup"
	| "heartbeat"
	| "resource"
	| "signal"
	| "shutdown"
	| "error";

/** 可 JSON 序列化的事件详情。 */
type JsonRecord = Record<string, unknown>;

/** 观测事件发送体。 */
type ObservationEvent = {
	/** 事件类型。 */
	eventType: ObservationEventType;
	/** 容器内递增序号。 */
	sequence: number;
	/** 容器内观测时间。 */
	observedAt: string;
	/** 事件详情。 */
	payload: JsonRecord;
};

let sequence = 0;
let shuttingDown = false;

/**
 * 读取文本文件；读取失败时返回 null，避免 cgroup 差异影响观测服务存活。
 * @param path 文件路径
 * @returns 文件内容
 */
async function readTextFile(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		// 不同运行时可能缺少某些 cgroup 文件，缺失时跳过对应指标。
		return null;
	}
}

/**
 * 读取整数文件。
 * @param path 文件路径
 * @returns 解析后的整数
 */
async function readNumberFile(path: string): Promise<number | null> {
	const content = await readTextFile(path);
	if (!content) {
		return null;
	}
	const value = Number.parseInt(content.trim(), 10);
	return Number.isFinite(value) ? value : null;
}

/**
 * 解析 cgroup v2 cpu.stat。
 * @returns CPU cgroup 指标
 */
async function readCpuStat(): Promise<JsonRecord | null> {
	const content = await readTextFile("/sys/fs/cgroup/cpu.stat");
	if (!content) {
		return null;
	}
	const stat: JsonRecord = {};
	for (const line of content.trim().split("\n")) {
		const [key, rawValue] = line.split(/\s+/, 2);
		const value = Number.parseInt(rawValue ?? "", 10);
		if (key && Number.isFinite(value)) {
			// cpu.stat 的数值单位由内核定义，原样落库便于和平台指标对齐。
			stat[key] = value;
		}
	}
	return stat;
}

/**
 * 采集当前容器/进程资源快照。
 * @returns 可写入观测事件 payload 的资源信息
 */
async function collectResourceUsage(): Promise<JsonRecord> {
	const memoryUsage = process.memoryUsage();
	const resourceUsage = process.resourceUsage();
	return {
		process: {
			pid: process.pid,
			uptime_seconds: process.uptime(),
			memory: memoryUsage,
			resource: resourceUsage,
		},
		host: {
			uptime_seconds: uptime(),
			loadavg: loadavg(),
			cpu_count: cpus().length,
			total_memory_bytes: totalmem(),
			free_memory_bytes: freemem(),
		},
		cgroup: {
			memory_current_bytes: await readNumberFile("/sys/fs/cgroup/memory.current"),
			memory_max_bytes: await readTextFile("/sys/fs/cgroup/memory.max"),
			cpu: await readCpuStat(),
		},
	};
}

/**
 * 构造基础运行时标签。
 * @returns 容器运行时环境标签
 */
function runtimeMetadata(): JsonRecord {
	return {
		application_id: process.env.CLOUDFLARE_APPLICATION_ID,
		deployment_id: process.env.CLOUDFLARE_DEPLOYMENT_ID,
		durable_object_id: process.env.CLOUDFLARE_DURABLE_OBJECT_ID,
		sandbox_id: process.env.NEO_NOUMI_SANDBOX_ID,
		location: process.env.CLOUDFLARE_LOCATION,
		region: process.env.CLOUDFLARE_REGION,
		country: process.env.CLOUDFLARE_COUNTRY_A2,
		hostname: process.env.HOSTNAME,
	};
}

/**
 * 发送一条观测事件。
 * @param eventType 事件类型
 * @param payload 事件详情
 */
async function sendObservation(
	eventType: ObservationEventType,
	payload: JsonRecord = {},
): Promise<void> {
	const body: ObservationEvent = {
		eventType,
		sequence: ++sequence,
		observedAt: new Date().toISOString(),
		payload: {
			...runtimeMetadata(),
			...payload,
		},
	};
	const response = await fetch(OBSERVABILITY_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`Observation write failed: ${response.status}`);
	}
}

/**
 * 执行心跳与资源上报。
 */
async function tick(): Promise<void> {
	await sendObservation("heartbeat");
	await sendObservation("resource", await collectResourceUsage());
}

/**
 * 处理容器转发来的退出信号。
 * @param signal 信号名称
 */
async function handleSignal(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	try {
		await sendObservation("signal", { signal });
		await sendObservation("shutdown", { reason: "signal", signal });
	} catch (error) {
		console.error("failed to flush signal observation", error);
	} finally {
		process.exit(signal === "SIGTERM" ? 0 : 128);
	}
}

const app = new Hono();

app.get("/health", (c) => {
	return c.json({ ok: true, sequence });
});

app.get("/metrics", async (c) => {
	return c.json(await collectResourceUsage());
});

for (const signal of OBSERVED_SIGNALS) {
	process.on(signal, () => {
		void handleSignal(signal);
	});
}

process.on("uncaughtException", (error) => {
	void sendObservation("error", {
		error_type: "uncaughtException",
		message: error.message,
		stack: error.stack,
	}).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
	void sendObservation("error", {
		error_type: "unhandledRejection",
		message: reason instanceof Error ? reason.message : String(reason),
		stack: reason instanceof Error ? reason.stack : undefined,
	}).finally(() => process.exit(1));
});

serve({
	port: PORT,
	fetch: app.fetch,
});

await sendObservation("startup", { port: PORT });
await tick();

setInterval(() => {
	void tick().catch((error) => {
		console.error("failed to send sandbox observation", error);
	});
}, HEARTBEAT_INTERVAL_MS);
