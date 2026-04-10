import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const originalConfigPath = process.env.BEE_SLACK_CONFIG;

afterEach(() => {
	if (originalConfigPath === undefined) {
		delete process.env.BEE_SLACK_CONFIG;
		return;
	}

	process.env.BEE_SLACK_CONFIG = originalConfigPath;
});

function writeConfig(contents: object): string {
	const directory = mkdtempSync(join(tmpdir(), "bee-slack-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(contents), "utf-8");
	return path;
}

describe("loadConfig", () => {
	it("loads the config from the environment", () => {
		const path = writeConfig({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: {
				servers: ["nats://127.0.0.1:4222"],
			},
			routes: [
				{
					id: "ops",
					match: { dm: true },
					worker: { subject: "bee.agent.ops" },
				},
			],
		});
		process.env.BEE_SLACK_CONFIG = path;

		expect(loadConfig()).toEqual({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: {
				servers: ["nats://127.0.0.1:4222"],
			},
			routes: [
				{
					id: "ops",
					match: { dm: true },
					worker: { subject: "bee.agent.ops" },
				},
			],
		});
	});
});
