import type {
	ActionUpdate,
	ArtifactRef,
	BlobStore,
	TransportOutputTarget,
	TransportSink,
	TransportStreamResult,
	TransportStreamStart,
} from "@jobmatchme/bee-gate";
import type { WebClient } from "@slack/web-api";
import { createReadStream } from "fs";

export const SLACK_STREAM_HEADER = "Ich bearbeite jetzt deine Anfrage...";
export const SLACK_PLAN_ACTIVE_TITLE = "Bee Willy arbeitet 🐝";
export const SLACK_PLAN_COMPLETE_TITLE = "Bee Willy ist fertig 🍯";
export const SLACK_PLAN_ERROR_TITLE = "Bee Willy braucht Hilfe 🐝";
export const SLACK_RUN_TASK_ID = "bee-run";
export const SLACK_RUN_TASK_TITLE = "Anfrage bearbeiten";
export const SLACK_TASK_TEXT_LIMIT = 256;
export const SLACK_MARKDOWN_LIMIT = 12_000;
export const SLACK_MARKDOWN_TRUNCATION_SUFFIX = "\n\n_[Antwort auf 12.000 Zeichen gekürzt]_";

function truncateCodePoints(text: string, limit: number, suffix: string): string {
	const codePoints = Array.from(text);
	if (codePoints.length <= limit) return text;
	const suffixCodePoints = Array.from(suffix);
	return `${codePoints.slice(0, Math.max(0, limit - suffixCodePoints.length)).join("")}${suffix}`;
}

export function truncateSlackTaskText(text: string): string {
	return truncateCodePoints(text, SLACK_TASK_TEXT_LIMIT, "…");
}

export function truncateSlackMarkdown(text: string): string {
	return truncateCodePoints(text, SLACK_MARKDOWN_LIMIT, SLACK_MARKDOWN_TRUNCATION_SUFFIX);
}

function requiredContextString(start: TransportStreamStart, key: string): string {
	const value = start.context?.[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing Slack stream context ${key}`);
	}
	return value;
}

export interface SlackSinkObserver {
	posted(target: TransportOutputTarget, ref: string, text: string): void;
	updated(target: TransportOutputTarget, ref: string, text: string): void;
}

export class SlackSink implements TransportSink<string> {
	constructor(
		private webClient: WebClient,
		private blobStore: BlobStore,
		private observer?: SlackSinkObserver,
	) {}
	private readonly taskDetailsSent = new Map<string, Set<string>>();
	private readonly planStreams = new Set<string>();

	async postMessage(target: TransportOutputTarget, text: string): Promise<string> {
		if (!target.channelId) {
			throw new Error("Missing Slack channel id");
		}

		const result = await this.webClient.chat.postMessage({
			channel: target.channelId,
			text,
			thread_ts: target.threadId,
		});
		const ref = result.ts as string;
		this.observer?.posted(target, ref, text);
		return ref;
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
		this.observer?.updated(target, ref, text);
	}

	prepareStreamText(text: string): string {
		return truncateSlackMarkdown(text);
	}

	async startStream(target: TransportOutputTarget, start: TransportStreamStart): Promise<string> {
		if (!target.channelId) throw new Error("Missing Slack channel id");
		if (!target.threadId) throw new Error("Missing Slack stream thread timestamp");

		const headerChunk = {
			type: "blocks",
			blocks: [
				{
					type: "header",
					text: { type: "plain_text", text: SLACK_STREAM_HEADER },
				},
			],
		};
		const planChunks =
			start.presentation === "plan"
				? [
						{ type: "plan_update", title: SLACK_PLAN_ACTIVE_TITLE },
						{
							type: "task_update",
							id: SLACK_RUN_TASK_ID,
							title: SLACK_RUN_TASK_TITLE,
							status: "in_progress",
						},
					]
				: [];
		const result = await this.webClient.chat.startStream({
			channel: target.channelId,
			thread_ts: target.threadId,
			recipient_user_id: requiredContextString(start, "recipientUserId"),
			recipient_team_id: requiredContextString(start, "recipientTeamId"),
			task_display_mode: start.presentation || "timeline",
			// Slack supports block chunks although the current SDK's chunk union omits them.
			chunks: [headerChunk, ...planChunks] as never,
		});
		if (!result.ts) throw new Error("Slack chat.startStream did not return a message timestamp");
		if (start.presentation === "plan") this.planStreams.add(result.ts);
		return result.ts;
	}

	async updateStream(target: TransportOutputTarget, ref: string, action: ActionUpdate): Promise<void> {
		if (!target.channelId) throw new Error("Missing Slack channel id");

		const sentTaskIds = this.taskDetailsSent.get(ref) ?? new Set<string>();
		const details = action.details === undefined || sentTaskIds.has(action.id) ? undefined : action.details;
		await this.webClient.chat.appendStream({
			channel: target.channelId,
			ts: ref,
			chunks: [
				{
					type: "task_update",
					id: action.id,
					title: truncateSlackTaskText(action.title),
					...(details === undefined ? {} : { details: truncateSlackTaskText(details) }),
					status: action.status,
				},
			],
		});
		if (details !== undefined) {
			sentTaskIds.add(action.id);
			this.taskDetailsSent.set(ref, sentTaskIds);
		}
	}

	async stopStream(target: TransportOutputTarget, ref: string, result: TransportStreamResult): Promise<void> {
		if (!target.channelId) throw new Error("Missing Slack channel id");
		const planChunks = this.planStreams.has(ref)
			? [
					{
						type: "task_update" as const,
						id: SLACK_RUN_TASK_ID,
						title: SLACK_RUN_TASK_TITLE,
						status: result.outcome,
					},
					{
						type: "plan_update" as const,
						title: result.outcome === "complete" ? SLACK_PLAN_COMPLETE_TITLE : SLACK_PLAN_ERROR_TITLE,
					},
				]
			: [];
		const payload = {
			channel: target.channelId,
			ts: ref,
			// The stream starts in chunk mode for header/task updates, so final text
			// must use the same mode. Top-level markdown_text is rejected by Slack
			// with streaming_mode_mismatch after chunk-based starts.
			chunks: [...planChunks, { type: "markdown_text" as const, text: truncateSlackMarkdown(result.text) }],
		};

		try {
			try {
				await this.webClient.chat.stopStream(payload);
			} catch {
				// One explicit retry keeps final-answer delivery resilient while remaining bounded.
				await this.webClient.chat.stopStream(payload);
			}
		} finally {
			this.taskDetailsSent.delete(ref);
			this.planStreams.delete(ref);
		}
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
				file: createReadStream(materialized.path),
				filename: materialized.filename,
				title: artifact.title || artifact.name || materialized.filename,
			});
		} finally {
			await materialized.cleanup?.();
		}
	}
}
