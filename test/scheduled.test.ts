import { describe, expect, it } from "vitest";
import { renderScheduledFinalMessage } from "../src/scheduled.js";

describe("renderScheduledFinalMessage", () => {
	it("includes the scheduled request in the final Slack message", () => {
		expect(
			renderScheduledFinalMessage(
				"Wie viele unique user likes hatte die Deutsche Post gestern?\n\nBitte antworte kompakt.",
				"- Anzahl unique user likes: 7\n- Datum/Zeitraum: 2026-06-16",
			),
		).toBe(
			"*Request:*\n\n" +
				"> Wie viele unique user likes hatte die Deutsche Post gestern?\n> \n> Bitte antworte kompakt.\n\n" +
				"*Antwort:*\n\n" +
				"- Anzahl unique user likes: 7\n- Datum/Zeitraum: 2026-06-16",
		);
	});

	it("escapes Slack control characters in the rendered request", () => {
		expect(renderScheduledFinalMessage("Check <@U123> & values > 10", "Done")).toContain(
			"> Check &lt;@U123&gt; &amp; values &gt; 10",
		);
	});

	it("returns the response unchanged when no request is available", () => {
		expect(renderScheduledFinalMessage(undefined, "Done")).toBe("Done");
	});
});
