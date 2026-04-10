import { describe, expect, it } from "vitest";
import { resolveRoute } from "../src/router.js";
import type { SlackInboundMessage, SlackRouteConfig } from "../src/types.js";

const baseMessage: SlackInboundMessage = {
	type: "mention",
	channelId: "C123",
	channelName: "agents",
	ts: "1711111111.000100",
	userId: "U123",
	text: "run diagnostics",
};

describe("resolveRoute", () => {
	it("matches a route and creates a normalized conversation id", () => {
		const routes: SlackRouteConfig[] = [
			{
				id: "ops gateway",
				match: {
					channelNames: ["agents"],
				},
				worker: {
					subject: "bee.agent.ops.gateway",
				},
			},
		];

		expect(
			resolveRoute(routes, baseMessage, {
				teamId: "T123",
				teamName: "Bee",
				botUserId: "B123",
			}),
		).toEqual({
			route: routes[0],
			conversationId: "slack:T123:C123:1711111111_000100",
			sessionId: "ops_gateway:slack:T123:C123:1711111111_000100",
			threadTs: "1711111111.000100",
		});
	});

	it("uses channel sessions for DMs", () => {
		const routes: SlackRouteConfig[] = [
			{
				id: "support",
				match: {
					dm: true,
				},
				worker: {
					subject: "bee.agent.support.dm",
				},
				session: {
					strategy: "channel",
					prefix: "dm-support",
				},
			},
		];

		expect(
			resolveRoute(
				routes,
				{
					...baseMessage,
					type: "dm",
					channelId: "D123",
					ts: "1711111111.000200",
					threadTs: "1711111111.000150",
				},
				{
					teamId: "T123",
					teamName: "Bee",
					botUserId: "B123",
				},
			),
		).toEqual({
			route: routes[0],
			conversationId: "slack:T123:D123:1711111111_000150",
			sessionId: "dm-support:slack:T123:D123:D123",
			threadTs: "1711111111.000150",
		});
	});
});
