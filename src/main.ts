#!/usr/bin/env node

import { startGatewayFromEnv } from "./gateway.js";
import { runScheduledSlackTurnFromFiles } from "./scheduled.js";

const [commandOrConfigPath, maybeConfigPath, maybeJobPath] = process.argv.slice(2);

if (commandOrConfigPath === "run-scheduled" || commandOrConfigPath === "scheduled") {
	await runScheduledSlackTurnFromFiles(maybeConfigPath, maybeJobPath);
} else {
	await startGatewayFromEnv(commandOrConfigPath);
}
