#!/usr/bin/env node

import { startGatewayFromEnv } from "./gateway.js";

await startGatewayFromEnv(process.argv[2]);
