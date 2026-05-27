import { isJsonObject } from "./json";

/** session 内容读取最多允许的单页大小。 */
const SESSION_DETAIL_MAX_PAGE_SIZE = 500;

/** 面向 UI/API 的安全会话字段，避免把 worker token 返回给浏览器。 */
const sessionDetailSelect = {
	id: true,
	title: true,
	userId: true,
	projectId: true,
	workerEpoch: true,
	workerStatus: true,
	containerStatus: true,
	sandboxId: true,
	externalMetadata: true,
	requiresActionDetails: true,
	createdAt: true,
	updatedAt: true,
	deletedAt: true,
	lastHeartbeatAt: true,
} as const;

/** 独立 session 内容 API 所需的最小 Prisma 能力。 */
type SessionDetailPrisma = {
	/** ChatSession 查询能力。 */
	chatSession: {
		/** 按当前用户查询未删除 session。 */
		findFirst: (args: {
			where: { id: string; userId: string; deletedAt: null };
			select: typeof sessionDetailSelect;
		}) => Promise<SessionDetail | null>;
	};
	/** ChatClientEvent 查询能力。 */
	chatClientEvent: {
		/** 按 sequence 分页查询 client events。 */
		findMany: (args: {
			where: { sessionId: string; sequenceNum?: { lt: number } };
			orderBy: { sequenceNum: "desc" };
			take: number;
		}) => Promise<ClientEventRow[]>;
	};
	/** ChatWorkerEvent 查询能力。 */
	chatWorkerEvent: {
		/** 按自增 ID 分页查询 timeline events。 */
		findMany: (args: {
			where: { sessionId: string; id?: { lt: number } };
			orderBy: { id: "desc" };
			take: number;
		}) => Promise<TimelineEventRow[]>;
	};
};

/** session 摘要 DTO。 */
type SessionDetail = {
	/** session ID。 */
	id: string;
	/** session 标题。 */
	title: string | null;
	/** owner 用户 ID。 */
	userId: string;
	/** 所属 project ID。 */
	projectId: string;
	/** 当前 worker epoch。 */
	workerEpoch: number;
	/** worker 状态。 */
	workerStatus: string;
	/** 容器状态。 */
	containerStatus: string;
	/** sandbox ID。 */
	sandboxId: string | null;
	/** 外部恢复 metadata。 */
	externalMetadata: unknown;
	/** 当前待处理动作详情。 */
	requiresActionDetails: unknown;
	/** 创建时间。 */
	createdAt: Date;
	/** 更新时间。 */
	updatedAt: Date;
	/** 软删除时间。 */
	deletedAt: Date | null;
	/** 最近心跳时间。 */
	lastHeartbeatAt: Date | null;
};

/** client event 数据库行。 */
type ClientEventRow = {
	/** 幂等事件 ID。 */
	eventId: string;
	/** client sequence。 */
	sequenceNum: number;
	/** 事件类型。 */
	eventType: string;
	/** 来源。 */
	source: string;
	/** 事件 payload。 */
	payload: unknown;
	/** 创建时间。 */
	createdAt: Date;
};

/** timeline event 数据库行。 */
type TimelineEventRow = {
	/** 数据库自增 ID。 */
	id: number;
	/** 幂等事件 ID。 */
	eventId: string;
	/** 事件类型。 */
	eventType: string;
	/** 事件 payload。 */
	payload: unknown;
	/** 是否为 ephemeral 事件。 */
	ephemeral: boolean;
	/** 创建时间。 */
	createdAt: Date;
};

/** session 内容查询参数。 */
type GetSessionDetailInput = {
	/** 当前登录用户 ID。 */
	userId: string;
	/** session ID。 */
	sessionId: string;
	/** 单页大小。 */
	limit: number;
	/** 是否读取更早历史。 */
	older: boolean;
	/** 当前已加载最早 client sequence。 */
	beforeClientSequence: number | null;
	/** 当前已加载最早 timeline ID。 */
	beforeTimelineId: number | null;
};

/** session 内容 API 响应。 */
type SessionDetailResponse = {
	/** session 摘要。 */
	session: SessionDetail;
	/** client events 当前页。 */
	clientEvents: ReturnType<typeof toClientEventDto>[];
	/** timeline 当前页。 */
	timeline: ReturnType<typeof toTimelineEventDto>[];
	/** 历史分页游标。 */
	history: {
		/** 是否还有更早的 client events。 */
		hasMoreClientEvents: boolean;
		/** 是否还有更早的 timeline。 */
		hasMoreTimeline: boolean;
		/** 当前页最早 client sequence。 */
		beforeClientSequence: number | null;
		/** 当前页最早 timeline ID。 */
		beforeTimelineId: number | null;
	};
};

/**
 * 读取安全页大小。
 * @param limit 原始 limit
 * @returns 限制后的页大小
 */
function clampSessionDetailLimit(limit: number): number {
	return Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), SESSION_DETAIL_MAX_PAGE_SIZE);
}

/**
 * 将 payload 收敛为对象，保持旧接口对异常 payload 的容错语义。
 * @param payload 数据库 payload
 * @returns JSON 对象
 */
function asPayloadObject(payload: unknown) {
	return isJsonObject(payload) ? payload : {};
}

/**
 * 转换 client event DTO。
 * @param row 数据库行
 * @returns API DTO
 */
function toClientEventDto(row: ClientEventRow) {
	return {
		event_id: row.eventId,
		sequence_num: row.sequenceNum,
		event_type: row.eventType,
		source: row.source,
		payload: asPayloadObject(row.payload),
		created_at: row.createdAt.toISOString(),
	};
}

/**
 * 转换 timeline event DTO。
 * @param row 数据库行
 * @returns API DTO
 */
function toTimelineEventDto(row: TimelineEventRow) {
	return {
		id: row.id,
		event_id: row.eventId,
		event_type: row.eventType,
		payload: asPayloadObject(row.payload),
		ephemeral: row.ephemeral,
		created_at: row.createdAt.toISOString(),
	};
}

/**
 * 读取 session 内容页，不依赖 CCR store 的运行态逻辑。
 * @param prisma 最小 Prisma 查询能力
 * @param input 查询参数
 * @returns session 内容；无权限或不存在时返回 null
 */
export async function getSessionDetailResponse(
	prisma: SessionDetailPrisma,
	input: GetSessionDetailInput,
): Promise<SessionDetailResponse | null> {
	const session = await prisma.chatSession.findFirst({
		where: {
			id: input.sessionId,
			userId: input.userId,
			deletedAt: null,
		},
		select: sessionDetailSelect,
	});
	if (!session) {
		return null;
	}

	const limit = clampSessionDetailLimit(input.limit);
	const take = limit + 1;
	const [rawClientEvents, rawTimeline] = await Promise.all([
		input.older
			? input.beforeClientSequence
				? prisma.chatClientEvent.findMany({
						where: { sessionId: input.sessionId, sequenceNum: { lt: input.beforeClientSequence } },
						orderBy: { sequenceNum: "desc" },
						take,
					})
				: Promise.resolve([])
			: prisma.chatClientEvent.findMany({
					where: { sessionId: input.sessionId },
					orderBy: { sequenceNum: "desc" },
					take,
				}),
		input.older
			? input.beforeTimelineId
				? prisma.chatWorkerEvent.findMany({
						where: { sessionId: input.sessionId, id: { lt: input.beforeTimelineId } },
						orderBy: { id: "desc" },
						take,
					})
				: Promise.resolve([])
			: prisma.chatWorkerEvent.findMany({
					where: { sessionId: input.sessionId },
					orderBy: { id: "desc" },
					take,
				}),
	]);
	const clientEvents = rawClientEvents.slice(0, limit).reverse().map(toClientEventDto);
	const timeline = rawTimeline.slice(0, limit).reverse().map(toTimelineEventDto);
	return {
		session,
		clientEvents,
		timeline,
		history: {
			hasMoreClientEvents: rawClientEvents.length > limit,
			hasMoreTimeline: rawTimeline.length > limit,
			beforeClientSequence: clientEvents[0]?.sequence_num ?? null,
			beforeTimelineId: timeline[0]?.id ?? null,
		},
	};
}
