import type { TransportOutputTarget } from "@jobmatchme/bee-gate";
import type { SlackHandoffReply } from "./types.js";

const MAX_REPLIES_PER_THREAD = 100;

export class HandoffReplyCache {
	private repliesByThread = new Map<string, SlackHandoffReply[]>();

	public recordPosted(target: TransportOutputTarget, ts: string, text: string, author = "Bee"): void {
		if (!target.channelId || !target.threadId) return;
		const key = threadKey(target.channelId, target.threadId);
		const replies = this.repliesByThread.get(key) || [];
		replies.push({ ts, threadTs: target.threadId, text, author, isBot: true });
		this.repliesByThread.set(key, replies.slice(-MAX_REPLIES_PER_THREAD));
	}

	public recordUpdated(target: TransportOutputTarget, ts: string, text: string, author = "Bee"): void {
		if (!target.channelId || !target.threadId) return;
		const key = threadKey(target.channelId, target.threadId);
		const replies = this.repliesByThread.get(key) || [];
		const existing = replies.find((reply) => reply.ts === ts);
		if (existing) {
			existing.text = text;
			existing.author = author;
			return;
		}
		this.recordPosted(target, ts, text, author);
	}

	public replies(channelId: string, threadTs: string): SlackHandoffReply[] {
		return (this.repliesByThread.get(threadKey(channelId, threadTs)) || []).map((reply) => ({ ...reply }));
	}
}

function threadKey(channelId: string, threadTs: string): string {
	return `${channelId}:${threadTs}`;
}
