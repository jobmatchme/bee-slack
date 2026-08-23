#!/usr/bin/env node

import { startGatewayFromEnv } from "./gateway.js";
import { runScheduledSlackTurnFromFiles } from "./scheduled.js";
import { initializeTelemetry, shutdownTelemetry } from "./telemetry.js";

const [commandOrConfigPath, maybeConfigPath, maybeJobPath] = process.argv.slice(2);

initializeTelemetry();

if (commandOrConfigPath === "run-scheduled" || commandOrConfigPath === "scheduled") {
	try {
		await runScheduledSlackTurnFromFiles(maybeConfigPath, maybeJobPath);
	} finally {
		await shutdownTelemetry();
	}
} else {
	process.once("SIGTERM", () => void shutdownTelemetry().finally(() => process.exit(0)));
	process.once("SIGINT", () => void shutdownTelemetry().finally(() => process.exit(0)));
	await startGatewayFromEnv(commandOrConfigPath);
}
