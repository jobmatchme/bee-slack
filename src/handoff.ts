import {
	type BeeResolvedTurn,
	buildConversationId,
	buildSessionKey,
	type TransportOutputTarget,
} from "@jobmatchme/bee-gate";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type {
	SlackHandoffConfig,
	SlackHandoffRecord,
	SlackHandoffReply,
	SlackHandoffRequest,
	SlackHandoffRouteConfig,
} from "./types.js";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_QUESTION_LENGTH = 4000;
const THREAD_TS_PATTERN = /^\d{10,}\.\d{6}$/;

export interface SlackHandoffDependencies {
	teamId: string;
	postRootMessage(channelId: string, text: string): Promise<string>;
	getPermalink(channelId: string, messageTs: string): Promise<string>;
	dispatch(input: BeeResolvedTurn): void;
	getReplies(channelId: string, threadTs: string): Promise<SlackHandoffReply[]>;
}

export class SlackHandoffController {
	private routes = new Map<string, SlackHandoffRouteConfig>();

	constructor(
		private config: SlackHandoffConfig,
		private dependencies: SlackHandoffDependencies,
	) {
		for (const route of config.routes) this.routes.set(route.id, route);
	}

	public publicRoutes(): Array<{ id: string; label: string }> {
		return this.config.routes.map((route) => ({ id: route.id, label: route.label || route.id }));
	}

	public async create(request: SlackHandoffRequest): Promise<SlackHandoffRecord> {
		const route = this.requireRoute(request.routeId);
		validateRequest(request, this.config.allowedDashboardHosts);

		const threadTs = await this.dependencies.postRootMessage(route.channelId, renderSlackHandoffMessage(request));
		const permalink = await this.dependencies.getPermalink(route.channelId, threadTs);
		const conversationId = buildConversationId(["slack", this.dependencies.teamId, route.channelId, threadTs]);
		const sessionBase = route.session?.strategy === "channel" ? route.channelId : threadTs;
		const sessionId = buildSessionKey(
			route.session?.prefix || route.id,
			buildConversationId(["slack", this.dependencies.teamId, route.channelId, sessionBase]),
		);
		const output: TransportOutputTarget = { channelId: route.channelId, threadId: threadTs };
		this.dependencies.dispatch({
			sessionId,
			threadId: threadTs,
			worker: route.worker,
			conversation: { transport: "slack", conversationId },
			actor: request.actor,
			message: { text: renderAgentRequest(request) },
			attachments: [],
			output,
		});

		return {
			routeId: route.id,
			channelId: route.channelId,
			threadTs,
			permalink,
			createdAt: new Date().toISOString(),
		};
	}

	public async replies(routeId: string, threadTs: string): Promise<SlackHandoffReply[]> {
		const route = this.requireRoute(routeId);
		if (!THREAD_TS_PATTERN.test(threadTs)) throw new HandoffHttpError(400, "Invalid thread timestamp");
		return this.dependencies.getReplies(route.channelId, threadTs);
	}

	private requireRoute(routeId: string): SlackHandoffRouteConfig {
		const route = this.routes.get(routeId);
		if (!route) throw new HandoffHttpError(404, "Unknown handoff route");
		return route;
	}
}

export function createHandoffServer(controller: SlackHandoffController): Server {
	return createServer(async (request, response) => {
		try {
			await handleRequest(controller, request, response);
		} catch (error) {
			const status = error instanceof HandoffHttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, status, { error: status === 500 ? "Internal handoff error" : message });
		}
	});
}

async function handleRequest(
	controller: SlackHandoffController,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const method = request.method || "GET";
	const url = new URL(request.url || "/", "http://bee-slack.internal");
	if (method === "GET" && url.pathname === "/health") {
		sendJson(response, 200, { ok: true, service: "bee-slack-handoff" });
		return;
	}
	if (method === "GET" && url.pathname === "/api/handoffs/routes") {
		sendJson(response, 200, { routes: controller.publicRoutes() });
		return;
	}
	if (method === "POST" && url.pathname === "/api/handoffs") {
		const body = withTrustedGrafanaActor(
			await readJsonBody<SlackHandoffRequest>(request),
			request.headers["x-grafana-user"],
		);
		sendJson(response, 201, { handoff: await controller.create(body) });
		return;
	}
	const match = url.pathname.match(/^\/api\/handoffs\/([^/]+)\/([^/]+)\/replies$/);
	if (method === "GET" && match) {
		sendJson(response, 200, { replies: await controller.replies(decodeURIComponent(match[1]), match[2]) });
		return;
	}
	throw new HandoffHttpError(404, "Not found");
}

export function withTrustedGrafanaActor(
	request: SlackHandoffRequest,
	trustedUserHeader: string | string[] | undefined,
): SlackHandoffRequest {
	if (typeof trustedUserHeader !== "string" || !trustedUserHeader.trim()) {
		throw new HandoffHttpError(401, "Authenticated Grafana user header is required");
	}
	return {
		...request,
		actor: { userId: trustedUserHeader, userName: trustedUserHeader },
	};
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new HandoffHttpError(413, "Request body too large");
	}
	try {
		return JSON.parse(body) as T;
	} catch {
		throw new HandoffHttpError(400, "Invalid JSON body");
	}
}

function validateRequest(request: SlackHandoffRequest, allowedHosts?: string[]): void {
	if (!request || typeof request !== "object") throw new HandoffHttpError(400, "Request body is required");
	if (!request.text?.trim()) throw new HandoffHttpError(400, "Question is required");
	if (request.text.length > MAX_QUESTION_LENGTH) throw new HandoffHttpError(400, "Question is too long");
	if (!request.actor?.userId?.trim()) throw new HandoffHttpError(400, "Actor userId is required");
	if (!request.context?.url?.trim()) throw new HandoffHttpError(400, "Grafana context URL is required");
	let contextUrl: URL;
	try {
		contextUrl = new URL(request.context.url);
	} catch {
		throw new HandoffHttpError(400, "Grafana context URL is invalid");
	}
	if (contextUrl.protocol !== "https:" && contextUrl.hostname !== "localhost") {
		throw new HandoffHttpError(400, "Grafana context URL must use HTTPS");
	}
	if (allowedHosts?.length && !allowedHosts.includes(contextUrl.hostname)) {
		throw new HandoffHttpError(400, "Grafana context host is not allowed");
	}
}

export function renderSlackHandoffMessage(request: SlackHandoffRequest): string {
	const actor = request.actor.displayName || request.actor.userName || request.actor.userId;
	const context = request.context;
	const title = context.panelTitle || context.dashboardTitle || "Grafana";
	const details = [
		context.dashboardTitle ? `*Dashboard:* ${escapeSlack(context.dashboardTitle)}` : undefined,
		context.panelTitle ? `*Panel:* ${escapeSlack(context.panelTitle)}` : undefined,
		context.timeRange ? `*Zeitraum:* ${escapeSlack(context.timeRange)}` : undefined,
		...Object.entries(context.variables || {}).map(
			([name, value]) => `*${escapeSlack(name)}:* ${escapeSlack(value)}`,
		),
	].filter((value): value is string => Boolean(value));
	return [
		`:honeybee: *Frage aus Grafana · ${escapeSlack(title)}*`,
		`*Von:* ${escapeSlack(actor)}`,
		...details,
		"",
		escapeSlack(request.text.trim()),
		"",
		`<${escapeSlack(context.url)}|Dashboard-Kontext öffnen>`,
	].join("\n");
}

export function renderAgentRequest(request: SlackHandoffRequest): string {
	const variables = Object.entries(request.context.variables || {})
		.map(([name, value]) => `- ${name}: ${value}`)
		.join("\n");
	return [
		request.text.trim(),
		"",
		"Grafana-Kontext:",
		request.context.dashboardTitle ? `- Dashboard: ${request.context.dashboardTitle}` : undefined,
		request.context.panelTitle ? `- Panel: ${request.context.panelTitle}` : undefined,
		request.context.timeRange ? `- Zeitraum: ${request.context.timeRange}` : undefined,
		variables || undefined,
		`- URL: ${request.context.url}`,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
}

function escapeSlack(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

class HandoffHttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
