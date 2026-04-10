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
	if (!config.appToken) throw new Error(`Missing appToken in ${fullPath}`);
	if (!config.botToken) throw new Error(`Missing botToken in ${fullPath}`);
	if (!config.nats?.servers || (Array.isArray(config.nats.servers) && config.nats.servers.length === 0)) {
		throw new Error(`Missing nats.servers in ${fullPath}`);
	}
	if (!Array.isArray(config.routes) || config.routes.length === 0) {
		throw new Error(`Missing routes in ${fullPath}`);
	}
	return config;
}
