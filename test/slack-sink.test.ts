import type { BlobStore } from "@jobmatchme/bee-gate";
import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import {
	SLACK_MARKDOWN_LIMIT,
	SLACK_MARKDOWN_TRUNCATION_SUFFIX,
	SLACK_STREAM_HEADER,
	SLACK_TASK_TEXT_LIMIT,
	SlackSink,
	truncateSlackMarkdown,
} from "../src/slack-sink.js";

function fixture() {
	const chat = {
		postMessage: vi.fn(),
		update: vi.fn(),
		startStream: vi.fn().mockResolvedValue({ ok: true, ts: "1711111111.000200" }),
		appendStream: vi.fn().mockResolvedValue({ ok: true }),
		stopStream: vi.fn().mockResolvedValue({ ok: true }),
	};
	const webClient = { chat, files: {} } as unknown as WebClient;
	const sink = new SlackSink(webClient, {} as BlobStore);
	return { chat, sink };
}

const target = { channelId: "C123", threadId: "1711111111.000100" };
const start = {
	runId: "run-1",
	routeId: "pilot",
	presentation: "timeline",
	context: { recipientUserId: "U123", recipientTeamId: "T123" },
};

describe("SlackSink native streaming", () => {
	it("starts a threaded stream with the required header and recipient context", async () => {
		const { chat, sink } = fixture();

		await expect(sink.startStream(target, start)).resolves.toBe("1711111111.000200");
		expect(chat.startStream).toHaveBeenCalledWith({
			channel: "C123",
			thread_ts: "1711111111.000100",
			recipient_user_id: "U123",
			recipient_team_id: "T123",
			task_display_mode: "timeline",
			chunks: [
				{
					type: "blocks",
					blocks: [
						{
							type: "header",
							text: { type: "plain_text", text: SLACK_STREAM_HEADER },
						},
					],
				},
			],
		});
	});

	it("requires a root thread, recipient context, and Slack stream timestamp", async () => {
		const { chat, sink } = fixture();
		await expect(sink.startStream({ channelId: "C123" }, start)).rejects.toThrow(
			"Missing Slack stream thread timestamp",
		);
		await expect(sink.startStream(target, { ...start, context: {} })).rejects.toThrow(
			"Missing Slack stream context recipientUserId",
		);
		chat.startStream.mockResolvedValueOnce({ ok: true });
		await expect(sink.startStream(target, start)).rejects.toThrow(
			"Slack chat.startStream did not return a message timestamp",
		);
	});

	it("maps generic action updates one-to-one and preserves repeated task ids", async () => {
		const { chat, sink } = fixture();
		const longTitle = `Datei lesen ${"😀".repeat(300)}`;
		const longDetails = `Kundendatei ${"x".repeat(300)}`;

		await sink.updateStream(target, "stream-1", {
			id: "tool-call-1",
			title: longTitle,
			details: longDetails,
			status: "in_progress",
		});
		await sink.updateStream(target, "stream-1", {
			id: "tool-call-1",
			title: "Datei lesen",
			details: longDetails,
			status: "complete",
		});
		await sink.updateStream(target, "stream-1", {
			id: "tool-call-2",
			title: "Befehl ausführen",
			details: "Daten prüfen",
			status: "error",
		});

		const firstChunk = chat.appendStream.mock.calls[0]?.[0].chunks[0];
		expect(Array.from(firstChunk.title)).toHaveLength(SLACK_TASK_TEXT_LIMIT);
		expect(Array.from(firstChunk.details)).toHaveLength(SLACK_TASK_TEXT_LIMIT);
		expect(firstChunk.title.endsWith("…")).toBe(true);
		expect(chat.appendStream).toHaveBeenNthCalledWith(2, {
			channel: "C123",
			ts: "stream-1",
			chunks: [
				{
					type: "task_update",
					id: "tool-call-1",
					title: "Datei lesen",
					status: "complete",
				},
			],
		});
		expect(chat.appendStream).toHaveBeenNthCalledWith(3, {
			channel: "C123",
			ts: "stream-1",
			chunks: [
				{
					type: "task_update",
					id: "tool-call-2",
					title: "Befehl ausführen",
					details: "Daten prüfen",
					status: "error",
				},
			],
		});
	});

	it("supports a no-task stream and sends markdown unchanged when it fits", async () => {
		const { chat, sink } = fixture();
		const markdown = "## Ergebnis\n\n* Punkt\n* **Fett**\n* [Link](https://example.com)";

		await sink.startStream(target, start);
		await sink.stopStream(target, "stream-1", { text: markdown, outcome: "complete" });

		expect(chat.appendStream).not.toHaveBeenCalled();
		expect(chat.stopStream).toHaveBeenCalledWith({
			channel: "C123",
			ts: "stream-1",
			chunks: [{ type: "markdown_text", text: markdown }],
		});
	});

	it("visibly and Unicode-safely truncates final markdown to 12,000 code points", () => {
		const markdown = `${"a".repeat(SLACK_MARKDOWN_LIMIT)}${"😀".repeat(10)}`;
		const truncated = truncateSlackMarkdown(markdown);

		expect(Array.from(truncated)).toHaveLength(SLACK_MARKDOWN_LIMIT);
		expect(truncated.endsWith(SLACK_MARKDOWN_TRUNCATION_SUFFIX)).toBe(true);
		expect(Array.from(truncated).join("")).toBe(truncated);
	});

	it("retries stop once and propagates the second failure", async () => {
		const { chat, sink } = fixture();
		chat.stopStream.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ ok: true });
		await expect(sink.stopStream(target, "stream-1", { text: "Done", outcome: "complete" })).resolves.toBeUndefined();
		expect(chat.stopStream).toHaveBeenCalledTimes(2);

		chat.stopStream.mockClear();
		chat.stopStream.mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("still down"));
		await expect(sink.stopStream(target, "stream-1", { text: "Done", outcome: "complete" })).rejects.toThrow(
			"still down",
		);
		expect(chat.stopStream).toHaveBeenCalledTimes(2);
	});

	it("propagates start and append errors for Gate fallback", async () => {
		const { chat, sink } = fixture();
		chat.startStream.mockRejectedValueOnce(new Error("not_allowed"));
		await expect(sink.startStream(target, start)).rejects.toThrow("not_allowed");

		chat.appendStream.mockRejectedValueOnce(new Error("rate_limited"));
		await expect(
			sink.updateStream(target, "stream-1", {
				id: "tool-call-1",
				title: "Datei lesen",
				status: "in_progress",
			}),
		).rejects.toThrow("rate_limited");
	});
});
