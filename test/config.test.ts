import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const originalConfigPath = process.env.BEE_SLACK_CONFIG;
const originalHandoffConfig = process.env.BEE_SLACK_HANDOFF_CONFIG;

afterEach(() => {
	if (originalHandoffConfig === undefined) delete process.env.BEE_SLACK_HANDOFF_CONFIG;
	else process.env.BEE_SLACK_HANDOFF_CONFIG = originalHandoffConfig;
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

	it("overrides handoff routes from a non-secret environment config", () => {
		const path = writeConfig({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: { servers: ["nats://127.0.0.1:4222"] },
			routes: [{ id: "ops", match: { dm: true }, worker: { subject: "bee.agent.ops" } }],
		});
		process.env.BEE_SLACK_CONFIG = path;
		process.env.BEE_SLACK_HANDOFF_CONFIG = JSON.stringify({
			enabled: true,
			routes: [{ id: "grafana", channelId: "C123", worker: { subject: "fabee.agent.pi.default" } }],
		});

		expect(loadConfig().handoff?.routes[0]).toMatchObject({
			id: "grafana",
			channelId: "C123",
			worker: { subject: "fabee.agent.pi.default" },
		});
	});

	it("accepts route-opt-in streaming modes", () => {
		const path = writeConfig({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: { servers: "nats://127.0.0.1:4222" },
			routes: [
				{
					id: "pilot",
					match: { channelIds: ["C123"] },
					worker: { subject: "bee.agent.pilot" },
					streaming: { enabled: true, taskDisplayMode: "dense" },
				},
			],
		});

		expect(loadConfig(path).routes[0]?.streaming).toEqual({ enabled: true, taskDisplayMode: "dense" });
	});

	it("accepts bounded route-opt-in thread context", () => {
		const path = writeConfig({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: { servers: "nats://127.0.0.1:4222" },
			routes: [
				{
					id: "product-feedback",
					match: { channelIds: ["C123"] },
					worker: { subject: "bee.agent.product-feedback" },
					threadContext: { enabled: true, maxMessages: 20, maxChars: 12_000 },
				},
			],
		});

		expect(loadConfig(path).routes[0]?.threadContext).toEqual({
			enabled: true,
			maxMessages: 20,
			maxChars: 12_000,
		});
	});

	it.each([
		[{ enabled: "yes" }, "threadContext.enabled must be a boolean"],
		[{ enabled: true, maxMessages: 0 }, "threadContext.maxMessages must be an integer between 1 and 50"],
		[{ enabled: true, maxMessages: 51 }, "threadContext.maxMessages must be an integer between 1 and 50"],
		[{ enabled: true, maxChars: 999 }, "threadContext.maxChars must be an integer between 1000 and 30000"],
		[{ enabled: true, maxChars: 30_001 }, "threadContext.maxChars must be an integer between 1000 and 30000"],
		[null, "threadContext must be an object"],
	])("rejects invalid route thread context config %#", (threadContext, expectedError) => {
		const path = writeConfig({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: { servers: "nats://127.0.0.1:4222" },
			routes: [
				{
					id: "product-feedback",
					match: { channelIds: ["C123"] },
					worker: { subject: "bee.agent.product-feedback" },
					threadContext,
				},
			],
		});

		expect(() => loadConfig(path)).toThrow(expectedError);
	});

	it.each([
		[{ enabled: "yes" }, "streaming.enabled must be a boolean"],
		[{ enabled: true, taskDisplayMode: "cards" }, "streaming.taskDisplayMode must be timeline, plan or dense"],
		[null, "streaming must be an object"],
	])("rejects invalid route streaming config %#", (streaming, expectedError) => {
		const path = writeConfig({
			appToken: "xapp-123",
			botToken: "xoxb-123",
			nats: { servers: "nats://127.0.0.1:4222" },
			routes: [
				{
					id: "pilot",
					match: { channelIds: ["C123"] },
					worker: { subject: "bee.agent.pilot" },
					streaming,
				},
			],
		});

		expect(() => loadConfig(path)).toThrow(expectedError);
	});
});
