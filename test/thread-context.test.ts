import { describe, expect, it } from "vitest";
import { formatSlackThreadContext } from "../src/thread-context.js";

const messages = [
	{ ts: "1.000", author: "Wendy", text: "Original feedback" },
	{ ts: "2.000", author: "Gunnar", text: "First reply" },
	{ ts: "3.000", author: "Bee Willy", text: "Earlier agent answer" },
	{ ts: "4.000", author: "Gunnar", text: "Current mention" },
];

describe("formatSlackThreadContext", () => {
	it("keeps the parent and prior replies while excluding the current mention", () => {
		const context = formatSlackThreadContext(messages, "4.000", { enabled: true });

		expect(context).toContain("Wendy: Original feedback");
		expect(context).toContain("Gunnar: First reply");
		expect(context).toContain("Bee Willy: Earlier agent answer");
		expect(context).not.toContain("Current mention");
		expect(context).toContain("UNTRUSTED SLACK THREAD CONTEXT");
	});

	it("keeps the parent and newest replies within the message limit", () => {
		const context = formatSlackThreadContext(messages, "missing", { enabled: true, maxMessages: 2 });

		expect(context).toContain("Wendy: Original feedback");
		expect(context).toContain("Gunnar: Current mention");
		expect(context).not.toContain("First reply");
		expect(context).toContain("2 earlier or oversized messages omitted");
	});

	it("keeps only the parent when the message limit is one", () => {
		const context = formatSlackThreadContext(messages, "missing", { enabled: true, maxMessages: 1 });

		expect(context).toContain("Wendy: Original feedback");
		expect(context).not.toContain("Current mention");
		expect(context).toContain("3 earlier or oversized messages omitted");
	});

	it("enforces the character budget and prefers recent replies after the parent", () => {
		const context = formatSlackThreadContext(
			[
				{ ts: "1.000", author: "Wendy", text: "Parent" },
				{ ts: "2.000", author: "Old", text: "x".repeat(900) },
				{ ts: "3.000", author: "Recent", text: "Important latest context" },
			],
			"missing",
			{ enabled: true, maxChars: 1_000 },
		);

		expect(context?.length).toBeLessThanOrEqual(1_000);
		expect(context).toContain("Wendy: Parent");
		expect(context).toContain("Recent: Important latest context");
		expect(context).not.toContain("Old:");
	});

	it("returns no context when the current mention is the only message", () => {
		expect(formatSlackThreadContext([messages[3]], "4.000", { enabled: true })).toBeUndefined();
	});
});
