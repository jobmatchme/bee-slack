import { readFileSync } from "fs";
import { resolve } from "path";
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
