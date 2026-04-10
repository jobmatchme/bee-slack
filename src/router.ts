import { buildConversationId, buildSessionKey } from "@jobmatchme/bee-gate";
import type { ResolvedSlackRoute, SlackGatewayContext, SlackInboundMessage, SlackRouteConfig } from "./types.js";

function matchesRoute(route: SlackRouteConfig, message: SlackInboundMessage): boolean {
	const match = route.match;

	if (message.type === "dm") {
		if (match.dm !== true) return false;
	} else if (match.dm === true) {
		return false;
	}

	if (match.channelIds && !match.channelIds.includes(message.channelId)) {
		return false;
	}

	if (match.channelNames && (!message.channelName || !match.channelNames.includes(message.channelName))) {
		return false;
	}

	if (match.textPrefix && !message.text.trim().startsWith(match.textPrefix)) {
		return false;
	}

	return true;
}

export function resolveRoute(
	routes: SlackRouteConfig[],
	message: SlackInboundMessage,
	context: SlackGatewayContext,
): ResolvedSlackRoute | null {
	const route = routes.find((candidate) => matchesRoute(candidate, message));
	if (!route) return null;

	const threadId = message.threadTs || (message.type === "mention" ? message.ts : undefined);
	const strategy = route.session?.strategy || "thread";
	const sessionBase = strategy === "channel" ? message.channelId : threadId || message.ts;
	const conversationId = buildConversationId(["slack", context.teamId, message.channelId, threadId || message.ts]);
	const prefix = route.session?.prefix || route.id;
	return {
		route,
		conversationId,
		sessionId: buildSessionKey(
			prefix,
			buildConversationId(["slack", context.teamId, message.channelId, sessionBase]),
		),
		threadTs: threadId,
	};
}
