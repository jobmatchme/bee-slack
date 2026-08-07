import type { ArtifactRef, BlobStore, TransportOutputTarget, TransportSink } from "@jobmatchme/bee-gate";
import type { WebClient } from "@slack/web-api";
import { createReadStream } from "fs";

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
