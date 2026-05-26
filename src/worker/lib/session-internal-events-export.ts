/** 全量会话恢复导出每次数据库分页读取的事件数。 */
const SESSION_INTERNAL_EVENT_EXPORT_PAGE_SIZE = 50;

/** 会话导出 API 所需的最小 Prisma 能力。 */
type SessionInternalEventsExportPrisma = {
	/** ChatSession 查询能力，用于鉴权确认 session 归属。 */
	chatSession: {
		/** 查询当前用户拥有的未删除 session。 */
		findFirst: (args: {
			where: { id: string; userId: string; deletedAt: null };
			select: { id: true };
		}) => Promise<{ id: string } | null>;
	};
	/** ChatInternalEvent 查询能力，用于按自增 ID 分页导出。 */
	chatInternalEvent: {
		/** 查询一页 internal events。 */
		findMany: (args: {
			where: { sessionId: string; id: { gt: number } };
			orderBy: { id: "asc" };
			take: number;
			select: {
				id: true;
				eventId: true;
				workerEpoch: true;
				eventType: true;
				payload: true;
				eventMetadata: true;
				isCompaction: true;
				agentId: true;
				createdAt: true;
			};
		}) => Promise<SessionInternalEventExportRow[]>;
	};
};

/** internal event 导出行。 */
type SessionInternalEventExportRow = {
	/** 数据库自增 ID，作为稳定分页游标。 */
	id: number;
	/** worker 上报的幂等事件 ID。 */
	eventId: string;
	/** 写入事件时的 worker epoch。 */
	workerEpoch: number;
	/** internal event 类型。 */
	eventType: string;
	/** 原始 Claude/CCR payload。 */
	payload: unknown;
	/** 事件 metadata。 */
	eventMetadata: unknown;
	/** 是否为 compaction 边界事件。 */
	isCompaction: boolean;
	/** subagent ID；foreground 事件为空。 */
	agentId: string | null;
	/** 数据库创建时间。 */
	createdAt: Date;
};

/** 创建流式导出响应所需参数。 */
type CreateSessionInternalEventsJsonlResponseInput = {
	/** 当前登录用户 ID。 */
	userId: string;
	/** 需要恢复的 session ID。 */
	sessionId: string;
	/** 请求取消信号。 */
	signal: AbortSignal;
};

/**
 * 将 internal event 数据库行序列化为恢复用 JSONL 行。
 * @param row internal event 数据库行
 * @returns 单行 JSONL 文本
 */
function serializeSessionInternalEventRow(row: SessionInternalEventExportRow): string {
	return `${JSON.stringify({
		id: row.id,
		event_id: row.eventId,
		worker_epoch: row.workerEpoch,
		event_type: row.eventType,
		payload: row.payload,
		event_metadata: row.eventMetadata,
		is_compaction: row.isCompaction,
		agent_id: row.agentId,
		created_at: row.createdAt.toISOString(),
	})}\n`;
}

/**
 * 创建恢复全量会话 internal events 的 JSONL 流式下载响应。
 * @param prisma 最小 Prisma 查询能力
 * @param input 当前用户与 session 参数
 * @returns JSONL 下载响应；session 不存在或无权限时返回 null
 */
export async function createSessionInternalEventsJsonlResponse(
	prisma: SessionInternalEventsExportPrisma,
	input: CreateSessionInternalEventsJsonlResponseInput,
): Promise<Response | null> {
	const session = await prisma.chatSession.findFirst({
		where: {
			id: input.sessionId,
			userId: input.userId,
			deletedAt: null,
		},
		select: { id: true },
	});
	if (!session) {
		return null;
	}

	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let cursor = 0;
			try {
				while (!input.signal.aborted) {
					// TODO: 后续可按 sessionId + cursor + pageSize 将早期分页写入 KV 长期缓存；历史 internal events 原则上不会再修改。
					const rows = await prisma.chatInternalEvent.findMany({
						where: {
							sessionId: input.sessionId,
							id: { gt: cursor },
						},
						orderBy: { id: "asc" },
						take: SESSION_INTERNAL_EVENT_EXPORT_PAGE_SIZE,
						select: {
							id: true,
							eventId: true,
							workerEpoch: true,
							eventType: true,
							payload: true,
							eventMetadata: true,
							isCompaction: true,
							agentId: true,
							createdAt: true,
						},
					});
					if (rows.length === 0) {
						break;
					}

					// 每页只拼接 50 条以内的短 JSONL chunk，写入后立刻交给响应流。
					controller.enqueue(encoder.encode(rows.map(serializeSessionInternalEventRow).join("")));
					cursor = rows[rows.length - 1]?.id ?? cursor;
					if (rows.length < SESSION_INTERNAL_EVENT_EXPORT_PAGE_SIZE) {
						break;
					}
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});

	return new Response(body, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"Content-Disposition": `attachment; filename="${input.sessionId}-internal-events.jsonl"`,
			"X-Content-Type-Options": "nosniff",
		},
	});
}
