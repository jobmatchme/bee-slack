import { readFileSync } from "fs";
import { resolve } from "path";
import { MAX_THREAD_CONTEXT_CHARS, MAX_THREAD_CONTEXT_MESSAGES } from "./thread-context.js";
import type { SlackGatewayConfig } from "./types.js";

export function loadConfig(configPath?: string): SlackGatewayConfig {
	const path = configPath || process.env.BEE_SLACK_CONFIG;
	if (!path) {
		throw new Error("Missing BEE_SLACK_CONFIG");
	}

	const fullPath = resolve(path);
	const config = JSON.parse(readFileSync(fullPath, "utf-8")) as SlackGatewayConfig;
	const handoffConfig = process.env.BEE_SLACK_HANDOFF_CONFIG;
	if (handoffConfig) {
		config.handoff = JSON.parse(handoffConfig) as SlackGatewayConfig["handoff"];
	}
	if (!config.appToken) throw new Error(`Missing appToken in ${fullPath}`);
	if (!config.botToken) throw new Error(`Missing botToken in ${fullPath}`);
	if (!config.nats?.servers || (Array.isArray(config.nats.servers) && config.nats.servers.length === 0)) {
		throw new Error(`Missing nats.servers in ${fullPath}`);
	}
	if (!Array.isArray(config.routes) || config.routes.length === 0) {
		throw new Error(`Missing routes in ${fullPath}`);
	}
	const taskDisplayModes = new Set(["timeline", "plan", "dense"]);
	for (const route of config.routes) {
		if (route.streaming !== undefined) {
			if (!route.streaming || typeof route.streaming !== "object" || Array.isArray(route.streaming)) {
				throw new Error(`Route ${route.id || "<unknown>"} streaming must be an object in ${fullPath}`);
			}
			if (typeof route.streaming.enabled !== "boolean") {
				throw new Error(`Route ${route.id || "<unknown>"} streaming.enabled must be a boolean in ${fullPath}`);
			}
			if (route.streaming.taskDisplayMode !== undefined && !taskDisplayModes.has(route.streaming.taskDisplayMode)) {
				throw new Error(
					`Route ${route.id || "<unknown>"} streaming.taskDisplayMode must be timeline, plan or dense in ${fullPath}`,
				);
			}
		}

		if (route.threadContext !== undefined) {
			if (!route.threadContext || typeof route.threadContext !== "object" || Array.isArray(route.threadContext)) {
				throw new Error(`Route ${route.id || "<unknown>"} threadContext must be an object in ${fullPath}`);
			}
			if (typeof route.threadContext.enabled !== "boolean") {
				throw new Error(`Route ${route.id || "<unknown>"} threadContext.enabled must be a boolean in ${fullPath}`);
			}
			if (
				route.threadContext.maxMessages !== undefined &&
				(!Number.isInteger(route.threadContext.maxMessages) ||
					route.threadContext.maxMessages < 1 ||
					route.threadContext.maxMessages > MAX_THREAD_CONTEXT_MESSAGES)
			) {
				throw new Error(
					`Route ${route.id || "<unknown>"} threadContext.maxMessages must be an integer between 1 and ${MAX_THREAD_CONTEXT_MESSAGES} in ${fullPath}`,
				);
			}
			if (
				route.threadContext.maxChars !== undefined &&
				(!Number.isInteger(route.threadContext.maxChars) ||
					route.threadContext.maxChars < 1_000 ||
					route.threadContext.maxChars > MAX_THREAD_CONTEXT_CHARS)
			) {
				throw new Error(
					`Route ${route.id || "<unknown>"} threadContext.maxChars must be an integer between 1000 and ${MAX_THREAD_CONTEXT_CHARS} in ${fullPath}`,
				);
			}
		}
	}

	if (config.handoff?.enabled) {
		if (!Array.isArray(config.handoff.routes) || config.handoff.routes.length === 0) {
			throw new Error(`handoff.routes must be a non-empty array in ${fullPath}`);
		}
		for (const route of config.handoff.routes) {
			if (!route.id || !route.channelId || !route.worker?.subject) {
				throw new Error(`Every handoff route needs id, channelId and worker.subject in ${fullPath}`);
			}
		}
	}
	return config;
}
