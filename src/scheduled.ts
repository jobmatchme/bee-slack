import {
	type ArtifactRef,
	type BeeResolvedTurn,
	type BeeRunEvent,
	type BeeWorkerClient,
	buildConversationId,
	buildSessionKey,
	createNatsBeeClient,
	LocalFileBlobStore,
	newTurnId,
	type TransportOutputTarget,
} from "@jobmatchme/bee-gate";
import { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { loadConfig } from "./config.js";
import * as log from "./log.js";
import { SlackSink } from "./slack-sink.js";
import { withTracedTurn } from "./telemetry.js";
import type { SlackGatewayConfig } from "./types.js";

export interface SlackScheduledRunConfig {
	id: string;
	routeId: string;
	text: string;
	target: {
		slackUserId?: string;
		channelId?: string;
		threadTs?: string;
	};
	actor?: {
		userId: string;
		userName?: string;
		displayName?: string;
	};
	sessionId?: string;
	sessionPrefix?: string;
	conversationId?: string;
}

interface RenderState {
	statusRef?: string;
	latestText: string;
	requestText?: string;
	itemTexts: Map<string, string>;
}

type ItemPartLike = { kind: string; [key: string]: unknown };

type ItemAppendedPayload = {
	eventType: "item.appended";
	item: { id: string; kind: string; role: string; parts: ItemPartLike[] };
};

type ItemUpdatedPayload = {
	eventType: "item.updated";
	itemId: string;
	appendParts?: ItemPartLike[];
};

type RunFailedPayload = {
	eventType: "run.failed";
	error: string;
};

type ApprovalRequestedPayload = {
	summary: string;
};

export function loadScheduledRunConfig(jobPath?: string): SlackScheduledRunConfig {
	const path = jobPath || process.env.BEE_SLACK_SCHEDULED_RUN_CONFIG;
	if (!path) {
		throw new Error(
			"Missing scheduled run config path; pass it as second argument or set BEE_SLACK_SCHEDULED_RUN_CONFIG",
		);
	}

	const fullPath = resolve(path);
	const config = JSON.parse(readFileSync(fullPath, "utf-8")) as SlackScheduledRunConfig;
	validateScheduledRunConfig(config, fullPath);
	return config;
}

export async function runScheduledSlackTurnFromFiles(configPath?: string, jobPath?: string): Promise<void> {
	const gatewayConfig = loadConfig(configPath);
	const scheduledRun = loadScheduledRunConfig(jobPath);
	await runScheduledSlackTurn(gatewayConfig, scheduledRun);
}

export async function runScheduledSlackTurn(
	gatewayConfig: SlackGatewayConfig,
	scheduledRun: SlackScheduledRunConfig,
): Promise<void> {
	validateScheduledRunConfig(scheduledRun, "scheduled run config");
	const route = gatewayConfig.routes.find((candidate) => candidate.id === scheduledRun.routeId);
	if (!route) {
		throw new Error(`Scheduled run ${scheduledRun.id} references unknown routeId ${scheduledRun.routeId}`);
	}

	const webClient = new WebClient(gatewayConfig.botToken);
	const blobStore = new LocalFileBlobStore(
		process.env.BEE_SLACK_BLOB_STORE_ROOT ||
			process.env.BEE_BLOB_STORE_ROOT ||
			process.env.HUDAI_BLOB_STORE_ROOT ||
			join(process.cwd(), ".bee-blob-store"),
	);
	const sink = new SlackSink(webClient, blobStore);
	const workerClient = await createNatsBeeClient(gatewayConfig.nats);

	try {
		const auth = await webClient.auth.test();
		const teamId = String(auth.team_id || "unknown-team");
		const output = await resolveScheduledOutputTarget(webClient, scheduledRun);
		const actor = await resolveScheduledActor(webClient, scheduledRun);
		let statusRef: string | undefined;
		if (!output.threadId) {
			statusRef = await sink.postMessage({ channelId: output.channelId }, "_Working..._");
			output.threadId = statusRef;
		}
		const slackConversationId = buildConversationId([
			"slack",
			teamId,
			output.channelId || "unknown-channel",
			output.threadId,
		]);
		const conversationId = scheduledRun.conversationId || slackConversationId;
		const sessionBase =
			route.session?.strategy === "channel" ? output.channelId || "unknown-channel" : output.threadId;
		const routeSessionId = buildSessionKey(
			scheduledRun.sessionPrefix || route.session?.prefix || route.id,
			buildConversationId(["slack", teamId, output.channelId || "unknown-channel", sessionBase || output.threadId]),
		);
		const sessionId = scheduledRun.sessionId || routeSessionId;

		const input: BeeResolvedTurn = {
			sessionId,
			threadId: output.threadId,
			worker: route.worker,
			conversation: {
				transport: "slack",
				conversationId,
			},
			actor,
			message: {
				text: scheduledRun.text,
			},
			attachments: [],
			output,
		};

		log.logInfo(`Starting scheduled Slack run ${scheduledRun.id} on route ${route.id}`);
		await streamScheduledTurn(workerClient, sink, input, statusRef);
		log.logInfo(`Completed scheduled Slack run ${scheduledRun.id}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.logError(`Scheduled Slack run ${scheduledRun.id} failed`, message);
		throw error;
	} finally {
		await workerClient.close?.();
	}
}

async function resolveScheduledOutputTarget(
	webClient: WebClient,
	scheduledRun: SlackScheduledRunConfig,
): Promise<TransportOutputTarget> {
	if (scheduledRun.target.channelId) {
		return {
			channelId: scheduledRun.target.channelId,
			threadId: scheduledRun.target.threadTs,
		};
	}

	if (!scheduledRun.target.slackUserId) {
		throw new Error(`Scheduled run ${scheduledRun.id} needs target.slackUserId or target.channelId`);
	}

	const result = await webClient.conversations.open({ users: scheduledRun.target.slackUserId });
	const channel = result.channel as { id?: string } | undefined;
	if (!channel?.id) {
		throw new Error(`Slack conversations.open did not return a channel for user ${scheduledRun.target.slackUserId}`);
	}
	return {
		channelId: channel.id,
		threadId: scheduledRun.target.threadTs,
	};
}

async function resolveScheduledActor(
	webClient: WebClient,
	scheduledRun: SlackScheduledRunConfig,
): Promise<BeeResolvedTurn["actor"]> {
	if (scheduledRun.actor) return scheduledRun.actor;
	if (!scheduledRun.target.slackUserId) {
		return {
			userId: `scheduler:${scheduledRun.id}`,
			displayName: "Bee Scheduler",
		};
	}

	try {
		const info = await webClient.users.info({ user: scheduledRun.target.slackUserId });
		const user = info.user as
			| { id?: string; name?: string; real_name?: string; profile?: { display_name?: string } }
			| undefined;
		return {
			userId: scheduledRun.target.slackUserId,
			userName: user?.name,
			displayName: user?.profile?.display_name || user?.real_name || user?.name,
		};
	} catch (error) {
		log.logWarning(
			`Could not resolve Slack user ${scheduledRun.target.slackUserId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			userId: scheduledRun.target.slackUserId,
			displayName: scheduledRun.target.slackUserId,
		};
	}
}

async function streamScheduledTurn(
	workerClient: BeeWorkerClient,
	sink: SlackSink,
	input: BeeResolvedTurn,
	statusRef?: string,
): Promise<void> {
	const state: RenderState = {
		statusRef,
		latestText: "_Working..._",
		requestText: input.message.text,
		itemTexts: new Map<string, string>(),
	};
	const request = {
		sessionId: input.sessionId,
		threadId: input.threadId,
		turnId: newTurnId(),
		conversation: input.conversation,
		actor: input.actor,
		message: input.message,
		attachments: input.attachments,
	};

	try {
		await withTracedTurn(
			"slack.scheduled_turn",
			{ "bee.session.id": input.sessionId, "bee.transport": "slack" },
			async (telemetry) => {
				await workerClient.streamTurn(input.worker, { ...request, telemetry }, async (event) => {
					await handleScheduledEvent(sink, input.output, event, state);
				});
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await sink.postMessage(input.output, `_Scheduled gateway error: ${message}_`);
		throw error;
	}
}

async function handleScheduledEvent(
	sink: SlackSink,
	output: TransportOutputTarget,
	event: BeeRunEvent,
	state: RenderState,
): Promise<void> {
	if (event.name === "run.started") {
		if (!state.statusRef) {
			state.statusRef = await sink.postMessage(output, state.latestText);
		}
		return;
	}

	if (event.name === "run.completed") {
		if (!state.statusRef) {
			state.statusRef = await sink.postMessage(output, state.latestText);
		}
		return;
	}

	if (event.name === "run.failed") {
		const errorText = `_Error: ${asRunFailedPayload(event).error}_`;
		if (state.statusRef) {
			await sink.updateMessage(output, state.statusRef, errorText);
		} else {
			state.statusRef = await sink.postMessage(output, errorText);
		}
		return;
	}

	if (event.name === "approval.requested") {
		await sink.postMessage(output, `Approval requested: ${asApprovalRequestedPayload(event).summary}`);
		return;
	}

	if (event.name === "item.appended") {
		const payload = asItemAppendedPayload(event);
		const text = renderParts(payload.item.parts);
		state.itemTexts.set(payload.item.id, text);
		if (payload.item.kind === "artifact") {
			const artifact = firstArtifactRef(payload.item.parts);
			if (artifact && artifactHasPayload(artifact)) {
				try {
					await sink.publishArtifact(output, artifact);
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await sink.postMessage(output, `${text}\n_Artifact upload failed: ${message}_`);
					return;
				}
			}
			await sink.postMessage(output, text);
			return;
		}
		state.latestText = renderScheduledFinalMessage(state.requestText, text);
		if (state.statusRef) {
			await sink.updateMessage(output, state.statusRef, state.latestText);
		} else {
			state.statusRef = await sink.postMessage(output, state.latestText);
		}
		return;
	}

	if (event.name === "item.updated") {
		const payload = asItemUpdatedPayload(event);
		const current = state.itemTexts.get(payload.itemId) || "";
		const appended = renderParts(payload.appendParts || []);
		const next = current ? `${current}${appended}` : appended;
		state.itemTexts.set(payload.itemId, next);
		state.latestText = renderScheduledFinalMessage(state.requestText, next);
		if (state.statusRef) {
			await sink.updateMessage(output, state.statusRef, state.latestText);
		} else {
			state.statusRef = await sink.postMessage(output, state.latestText);
		}
	}
}

function firstArtifactRef(parts: ItemPartLike[]): ArtifactRef | undefined {
	const part = parts.find((entry) => entry.kind === "artifactRef");
	if (!part) return undefined;
	return {
		artifactId: String(part.artifactId || "artifact"),
		blobKey: typeof part.blobKey === "string" ? part.blobKey : undefined,
		name: typeof part.name === "string" ? part.name : undefined,
		title: typeof part.title === "string" ? part.title : undefined,
		mimeType: typeof part.mimeType === "string" ? part.mimeType : undefined,
		uri: typeof part.uri === "string" ? part.uri : undefined,
		sizeBytes: typeof part.sizeBytes === "number" ? part.sizeBytes : undefined,
	};
}

function artifactHasPayload(artifact: ArtifactRef): boolean {
	return !!(artifact.uri || artifact.blobKey);
}

export function renderScheduledFinalMessage(requestText: string | undefined, responseText: string): string {
	const request = requestText?.trim();
	if (!request) return responseText;

	const quotedRequest = request
		.split(/\r?\n/)
		.map((line) => `> ${escapeSlackText(line)}`)
		.join("\n");

	return ["*Request:*", quotedRequest, "*Antwort:*", responseText].filter(Boolean).join("\n\n");
}

function escapeSlackText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderParts(parts: ItemPartLike[]): string {
	return parts
		.map((part) => {
			if (part.kind === "text") return String(part.text || "");
			if (part.kind === "status") return String(part.status || "");
			if (part.kind === "artifactRef") {
				return `Artifact: ${String(part.title || part.name || part.artifactId || "artifact")}`;
			}
			if (part.kind === "approval" || part.kind === "choice") {
				return `${String(part.title || "")}\n${String(part.summary || "")}`.trim();
			}
			if (part.kind === "form") return String(part.title || "");
			if (part.kind === "log") return String(part.text || "");
			if (part.kind === "patch" || part.kind === "diff") {
				const files = Array.isArray(part.files) ? (part.files as Array<{ path?: unknown }>) : [];
				return files.map((entry) => `File: ${String(entry.path || "")}`).join("\n");
			}
			return JSON.stringify(part);
		})
		.filter(Boolean)
		.join("\n");
}

function validateScheduledRunConfig(config: SlackScheduledRunConfig, source: string): void {
	if (!config.id) throw new Error(`Missing id in ${source}`);
	if (!config.routeId) throw new Error(`Missing routeId in ${source}`);
	if (!config.text) throw new Error(`Missing text in ${source}`);
	if (!config.target) throw new Error(`Missing target in ${source}`);
	if (!config.target.slackUserId && !config.target.channelId) {
		throw new Error(`Missing target.slackUserId or target.channelId in ${source}`);
	}
}

function asRunFailedPayload(event: BeeRunEvent): RunFailedPayload {
	return event.payload as RunFailedPayload;
}

function asApprovalRequestedPayload(event: BeeRunEvent): ApprovalRequestedPayload {
	return event.payload as ApprovalRequestedPayload;
}

function asItemAppendedPayload(event: BeeRunEvent): ItemAppendedPayload {
	return event.payload as ItemAppendedPayload;
}

function asItemUpdatedPayload(event: BeeRunEvent): ItemUpdatedPayload {
	return event.payload as ItemUpdatedPayload;
}
