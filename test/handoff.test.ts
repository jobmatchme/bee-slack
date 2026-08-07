import type { BeeResolvedTurn } from "@jobmatchme/bee-gate";
import { describe, expect, it, vi } from "vitest";
import { renderSlackHandoffMessage, SlackHandoffController, withTrustedGrafanaActor } from "../src/handoff.js";
import type { SlackHandoffRequest } from "../src/types.js";

const request: SlackHandoffRequest = {
	routeId: "grafana-fabee",
	text: "Warum sinkt die Conversion?",
	actor: { userId: "gunnar@jobmatch.me", displayName: "Gunnar" },
	context: {
		dashboardTitle: "Matching Event Funnel",
		panelTitle: "Conversion",
		url: "https://grafana.bi.jobmatch.me/d/matching?from=now-6h&to=now",
		timeRange: "Letzte 6 Stunden",
		variables: { Service: "All" },
	},
};

function createController() {
	const dispatch = vi.fn<(input: BeeResolvedTurn) => void>();
	const postRootMessage = vi.fn<(channelId: string, text: string) => Promise<string>>(async () => "1786100000.123456");
	const controller = new SlackHandoffController(
		{
			enabled: true,
			allowedDashboardHosts: ["grafana.bi.jobmatch.me"],
			routes: [
				{
					id: "grafana-fabee",
					label: "#bee-test-fabi",
					channelId: "C0AT02SV92N",
					worker: { subject: "fabee.agent.pi.default" },
					session: { strategy: "thread", prefix: "bee" },
				},
			],
		},
		{
			teamId: "T123",
			postRootMessage,
			getPermalink: vi.fn(async () => "https://slack.example/thread"),
			dispatch,
			getReplies: vi.fn(async () => [
				{ ts: "1786100001.123456", text: "Antwort", author: "Bee Willy", isBot: true },
			]),
		},
	);
	return { controller, dispatch, postRootMessage };
}

describe("SlackHandoffController", () => {
	it("posts a root message, dispatches into its thread and returns the permalink", async () => {
		const { controller, dispatch } = createController();

		const result = await controller.create(request);

		expect(result).toMatchObject({
			routeId: "grafana-fabee",
			channelId: "C0AT02SV92N",
			threadTs: "1786100000.123456",
			permalink: "https://slack.example/thread",
		});
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0][0]).toMatchObject({
			threadId: "1786100000.123456",
			worker: { subject: "fabee.agent.pi.default" },
			conversation: { transport: "slack" },
			output: { channelId: "C0AT02SV92N", threadId: "1786100000.123456" },
		});
		expect(dispatch.mock.calls[0][0].message.text).toContain("Service: All");
	});

	it("reads replies only for an allowlisted route", async () => {
		const { controller } = createController();

		await expect(controller.replies("grafana-fabee", "1786100000.123456")).resolves.toEqual([
			{ ts: "1786100001.123456", text: "Antwort", author: "Bee Willy", isBot: true },
		]);
		await expect(controller.replies("unknown", "1786100000.123456")).rejects.toThrow("Unknown handoff route");
	});

	it("rejects dashboard hosts outside the allowlist before posting", async () => {
		const { controller, dispatch } = createController();

		await expect(
			controller.create({ ...request, context: { ...request.context, url: "https://example.org/private" } }),
		).rejects.toThrow("Grafana context host is not allowed");
		expect(dispatch).not.toHaveBeenCalled();
	});
});

describe("renderSlackHandoffMessage", () => {
	it("renders visible context and escapes Slack markup", () => {
		const rendered = renderSlackHandoffMessage({ ...request, text: "Ist A < B & B > C?" });

		expect(rendered).toContain("Frage aus Grafana · Conversion");
		expect(rendered).toContain("*Service:* All");
		expect(rendered).toContain("Ist A &lt; B &amp; B &gt; C?");
		expect(rendered).toContain("Dashboard-Kontext öffnen");
	});
});

describe("trusted Grafana actor", () => {
	it("requires the proxy header and replaces the browser actor", () => {
		expect(() => withTrustedGrafanaActor(request, undefined)).toThrow(
			"Authenticated Grafana user header is required",
		);
		expect(withTrustedGrafanaActor({ ...request, actor: { userId: "spoofed" } }, "gunnar").actor).toEqual({
			userId: "gunnar",
			userName: "gunnar",
		});
	});
});
