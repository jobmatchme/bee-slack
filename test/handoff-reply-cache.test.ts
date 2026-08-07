import { describe, expect, it } from "vitest";
import { HandoffReplyCache } from "../src/handoff-reply-cache.js";

describe("HandoffReplyCache", () => {
	it("records and updates outbound Bee replies for one Slack thread", () => {
		const cache = new HandoffReplyCache();
		const target = { channelId: "C123", threadId: "1786114262.324949" };

		cache.recordPosted(target, "1786114263.000100", "Ich prüfe das.", "Fabee");
		cache.recordUpdated(target, "1786114263.000100", "Hier ist die Antwort.", "Fabee");

		expect(cache.replies("C123", "1786114262.324949")).toEqual([
			{
				ts: "1786114263.000100",
				threadTs: "1786114262.324949",
				text: "Hier ist die Antwort.",
				author: "Fabee",
				isBot: true,
			},
		]);
	});

	it("ignores root messages and isolates threads", () => {
		const cache = new HandoffReplyCache();
		cache.recordPosted({ channelId: "C123" }, "1786114262.324949", "Root");
		cache.recordPosted({ channelId: "C123", threadId: "1786114262.324949" }, "1786114263.1", "Antwort");

		expect(cache.replies("C123", "other")).toEqual([]);
		expect(cache.replies("C123", "1786114262.324949")).toHaveLength(1);
	});
});
