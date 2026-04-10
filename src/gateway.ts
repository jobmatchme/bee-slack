import {
	type ArtifactRef,
	type AttachmentRef,
	BeeGatewayEngine,
	type BeeResolvedTurn,
	type BeeWorkerClient,
	type BlobStore,
	createNatsBeeClient,
	LocalFileBlobStore,
	type TransportOutputTarget,
	type TransportSink,
} from "@jobmatchme/bee-gate";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { join } from "path";
import { loadConfig } from "./config.js";
import * as log from "./log.js";
import { resolveRoute } from "./router.js";
import type { ResolvedSlackRoute, SlackFile, SlackGatewayConfig, SlackInboundMessage } from "./types.js";

interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

interface SlackChannel {
	id: string;
	name: string;
}

class SlackSink implements TransportSink<string> {
	constructor(
		private webClient: WebClient,
		private blobStore: BlobStore,
	) {}

	async postMessage(target: TransportOutputTarget, text: string): Promise<string> {
		if (!target.channelId) {
			throw new Error("Missing Slack channel id");
		}

		const result = await this.webClient.chat.postMessage({
			channel: target.channelId,
			text,
			thread_ts: target.threadId,
		});
		return result.ts as string;
	}

	async updateMessage(target: TransportOutputTarget, ref: string, text: string): Promise<void> {
		if (!target.channelId) {
			throw new Error("Missing Slack channel id");
		}

		await this.webClient.chat.update({
			channel: target.channelId,
			ts: ref,
			text,
		});
	}

	async publishArtifact(target: TransportOutputTarget, artifact: ArtifactRef): Promise<void> {
		if (!target.channelId) {
			throw new Error("Missing Slack channel id");
		}

		const materialized = await this.blobStore.materialize(artifact);
		try {
			await (this.webClient.files as any).uploadV2({
				channel_id: target.channelId,
				thread_ts: target.threadId,
				file: materialized.path,
				filename: materialized.filename,
				title: artifact.title || artifact.name || materialized.filename,
			});
		} finally {
			await materialized.cleanup?.();
		}
	}
}

export class SlackGateway {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private botUserId: string | null = null;
	private teamId: string | null = null;
	private teamName: string | null = null;
	private blobStore: BlobStore;
	private sink: SlackSink;
	private engine: BeeGatewayEngine<string> | null = null;
	private workerClient: BeeWorkerClient | null = null;

	constructor(private config: SlackGatewayConfig) {
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
		this.blobStore = new LocalFileBlobStore(
			process.env.BEE_SLACK_BLOB_STORE_ROOT ||
				process.env.BEE_BLOB_STORE_ROOT ||
				process.env.HUDAI_BLOB_STORE_ROOT ||
				join(process.cwd(), ".bee-blob-store"),
		);
		this.sink = new SlackSink(this.webClient, this.blobStore);
	}

	async start(): Promise<void> {
		this.workerClient = await createNatsBeeClient(this.config.nats);
		this.engine = new BeeGatewayEngine({
			sink: this.sink,
			workerClient: this.workerClient,
			logger: {
				info: log.logInfo,
				warn: log.logWarning,
				error: log.logError,
			},
		});
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;
		this.teamId = auth.team_id as string;
		this.teamName = (auth.team as string | undefined) || null;
		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		this.setupEventHandlers();
		await this.socketClient.start();
		log.logInfo(
			`Connected as ${this.botUserId} in ${this.teamId}; loaded ${this.channels.size} channels and ${this.users.size} users`,
		);
	}

	private setupEventHandlers(): void {
		this.socketClient.on("app_mention", async ({ event, ack }) => {
			await ack();
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: SlackFile[];
			};

			if (e.channel.startsWith("D")) return;

			await this.enqueueInbound({
				type: "mention",
				channelId: e.channel,
				channelName: this.channels.get(e.channel)?.name,
				threadTs: e.thread_ts,
				ts: e.ts,
				userId: e.user,
				userName: this.users.get(e.user)?.userName,
				displayName: this.users.get(e.user)?.displayName,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			});
		});

		this.socketClient.on("message", async ({ event, ack }) => {
			await ack();
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: SlackFile[];
			};

			if (e.bot_id || !e.user || e.user === this.botUserId) return;
			if (e.subtype !== undefined && e.subtype !== "file_share") return;
			if (!e.text && (!e.files || e.files.length === 0)) return;

			const isDM = e.channel_type === "im";
			const isBotMention = !!this.botUserId && e.text?.includes(`<@${this.botUserId}>`);
			if (!isDM && isBotMention) return;
			if (!isDM) return;

			await this.enqueueInbound({
				type: "dm",
				channelId: e.channel,
				channelName: this.channels.get(e.channel)?.name,
				threadTs: e.thread_ts,
				ts: e.ts,
				userId: e.user,
				userName: this.users.get(e.user)?.userName,
				displayName: this.users.get(e.user)?.displayName,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			});
		});
	}

	private async enqueueInbound(message: SlackInboundMessage): Promise<void> {
		if (!this.botUserId || !this.teamId) {
			throw new Error("Gateway has not been initialized");
		}
		if (!this.engine) {
			throw new Error("Gateway engine has not been initialized");
		}

		try {
			const resolved = resolveRoute(this.config.routes, message, {
				botUserId: this.botUserId,
				teamId: this.teamId,
				teamName: this.teamName || undefined,
			});
			if (!resolved) {
				log.logWarning(`No route for channel ${message.channelId}`);
				return;
			}

			const outputTarget = this.buildOutputTarget(message, resolved);
			if (message.text.trim().toLowerCase() === "stop") {
				const stopped = await this.engine.stopActiveRun(resolved.sessionId);
				await this.sink.postMessage(outputTarget, stopped ? "Stopping active run." : "Nothing running.");
				return;
			}

			const attachments = await this.downloadAttachments(resolved, message);
			const input = this.buildResolvedTurn(message, resolved, attachments, outputTarget);
			this.engine.dispatch(input);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			log.logError(`Failed to normalize Slack inbound message ${message.ts}`, messageText);
			await this.sink.postMessage(
				{
					channelId: message.channelId,
					threadId: message.threadTs || (message.type === "mention" ? message.ts : undefined),
				},
				`_Gateway error: ${messageText}_`,
			);
		}
	}

	private buildResolvedTurn(
		message: SlackInboundMessage,
		resolved: ResolvedSlackRoute,
		attachments: AttachmentRef[],
		output: TransportOutputTarget,
	): BeeResolvedTurn {
		if (!this.teamId || !this.botUserId) {
			throw new Error("Missing Slack gateway identity");
		}

		return {
			sessionId: resolved.sessionId,
			threadId: resolved.threadTs,
			worker: resolved.route.worker,
			conversation: {
				transport: "slack",
				conversationId: resolved.conversationId,
			},
			actor: {
				userId: message.userId,
				userName: message.userName,
				displayName: message.displayName,
			},
			message: {
				text: message.text,
			},
			attachments,
			output,
		};
	}

	private buildOutputTarget(message: SlackInboundMessage, resolved: ResolvedSlackRoute): TransportOutputTarget {
		return {
			channelId: message.channelId,
			threadId: resolved.threadTs || (message.type === "mention" ? message.ts : undefined),
		};
	}

	private async downloadAttachments(
		resolved: ResolvedSlackRoute,
		message: SlackInboundMessage,
	): Promise<AttachmentRef[]> {
		const files = message.files || [];
		if (files.length === 0) return [];

		const attachments: AttachmentRef[] = [];
		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url || !file.name) continue;
			const response = await fetch(url, {
				headers: { authorization: `Bearer ${this.config.botToken}` },
			});
			if (!response.ok) {
				throw new Error(`Failed to download Slack attachment ${file.name}: ${response.status}`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			attachments.push(
				await this.blobStore.put({
					namespace: `incoming/slack/${resolved.sessionId}`,
					name: file.name,
					title: file.name,
					mimeType: file.mimetype,
					data: bytes,
				}),
			);
		}
		return attachments;
	}

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const user of members) {
					if (user.id && user.name && !user.deleted) {
						this.users.set(user.id, {
							id: user.id,
							userName: user.name,
							displayName: user.real_name || user.name,
						});
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel,im",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; user?: string }> | undefined;
			if (channels) {
				for (const channel of channels) {
					if (!channel.id) continue;
					if (channel.name) {
						this.channels.set(channel.id, { id: channel.id, name: channel.name });
					} else if (channel.user && this.users.has(channel.user)) {
						this.channels.set(channel.id, {
							id: channel.id,
							name: `DM:${this.users.get(channel.user)!.userName}`,
						});
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}

export async function startGatewayFromEnv(configPath?: string): Promise<void> {
	const config = loadConfig(configPath);
	const gateway = new SlackGateway(config);
	await gateway.start();
}
