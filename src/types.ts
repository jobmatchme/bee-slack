import type { BeeWorkerTargetConfig } from "@jobmatchme/bee-gate";

export interface SlackRouteMatch {
	channelIds?: string[];
	channelNames?: string[];
	dm?: boolean;
	textPrefix?: string;
}

export interface SlackSessionConfig {
	strategy?: "channel" | "thread";
	prefix?: string;
}

export interface SlackRouteConfig {
	id: string;
	match: SlackRouteMatch;
	worker: BeeWorkerTargetConfig;
	session?: SlackSessionConfig;
}

export interface SlackGatewayConfig {
	appToken: string;
	botToken: string;
	nats: {
		servers: string | string[];
		name?: string;
	};
	routes: SlackRouteConfig[];
	handoff?: SlackHandoffConfig;
}

export interface SlackHandoffConfig {
	enabled?: boolean;
	host?: string;
	port?: number;
	allowedDashboardHosts?: string[];
	routes: SlackHandoffRouteConfig[];
}

export interface SlackHandoffRouteConfig {
	id: string;
	label?: string;
	channelId: string;
	worker: BeeWorkerTargetConfig;
	session?: SlackSessionConfig;
}

export interface SlackHandoffActor {
	userId: string;
	userName?: string;
	displayName?: string;
}

export interface SlackHandoffContext {
	dashboardTitle?: string;
	dashboardUid?: string;
	panelTitle?: string;
	panelId?: number;
	url: string;
	timeRange?: string;
	variables?: Record<string, string>;
}

export interface SlackHandoffRequest {
	routeId: string;
	text: string;
	actor: SlackHandoffActor;
	context: SlackHandoffContext;
}

export interface SlackHandoffReply {
	ts: string;
	threadTs?: string;
	text: string;
	author?: string;
	isBot: boolean;
}

export interface SlackHandoffRecord {
	routeId: string;
	channelId: string;
	threadTs: string;
	permalink: string;
	createdAt: string;
}

export interface SlackFile {
	id?: string;
	mimetype?: string;
	name?: string;
	size?: number;
	url_private_download?: string;
	url_private?: string;
}

export interface SlackInboundMessage {
	type: "mention" | "dm";
	channelId: string;
	channelName?: string;
	threadTs?: string;
	ts: string;
	userId: string;
	userName?: string;
	displayName?: string;
	text: string;
	files?: SlackFile[];
}

export interface ResolvedSlackRoute {
	route: SlackRouteConfig;
	sessionId: string;
	threadTs?: string;
	conversationId: string;
}

export interface SlackGatewayContext {
	teamId: string;
	teamName?: string;
	botUserId: string;
}
