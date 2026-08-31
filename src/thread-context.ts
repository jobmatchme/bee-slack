import type { SlackThreadContextConfig } from "./types.js";

export const DEFAULT_THREAD_CONTEXT_MAX_MESSAGES = 20;
export const DEFAULT_THREAD_CONTEXT_MAX_CHARS = 12_000;
export const MAX_THREAD_CONTEXT_MESSAGES = 50;
export const MAX_THREAD_CONTEXT_CHARS = 30_000;
const MAX_THREAD_MESSAGE_CHARS = 4_000;

export interface SlackThreadContextMessage {
	ts: string;
	author: string;
	text: string;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function renderMessage(message: SlackThreadContextMessage): string {
	const text = truncate(message.text.trim(), MAX_THREAD_MESSAGE_CHARS);
	return `[${message.ts}] ${message.author}: ${text}`;
}

export function formatSlackThreadContext(
	messages: SlackThreadContextMessage[],
	currentMessageTs: string,
	config: SlackThreadContextConfig,
): string | undefined {
	const eligible = messages.filter((message) => message.ts !== currentMessageTs && message.text.trim().length > 0);
	if (eligible.length === 0) return undefined;

	const maxMessages = config.maxMessages ?? DEFAULT_THREAD_CONTEXT_MAX_MESSAGES;
	const maxChars = config.maxChars ?? DEFAULT_THREAD_CONTEXT_MAX_CHARS;
	const root = eligible[0];
	const recent = maxMessages > 1 ? eligible.slice(1).slice(-(maxMessages - 1)) : [];
	const header = "--- BEGIN UNTRUSTED SLACK THREAD CONTEXT (same channel) ---";
	const footer = "--- END UNTRUSTED SLACK THREAD CONTEXT ---";
	const fixedChars = header.length + footer.length + 2;
	const availableChars = Math.max(0, maxChars - fixedChars);
	const rootLine = root ? truncate(renderMessage(root), availableChars) : undefined;
	let usedChars = rootLine?.length ?? 0;
	const keptRecent: string[] = [];

	for (const message of [...recent].reverse()) {
		const line = renderMessage(message);
		const separatorChars = usedChars > 0 ? 1 : 0;
		if (usedChars + separatorChars + line.length > availableChars) continue;
		keptRecent.push(line);
		usedChars += separatorChars + line.length;
	}

	const lines = [rootLine, ...[...keptRecent].reverse()].filter((line): line is string => Boolean(line));
	const omitted = eligible.length - lines.length;
	if (omitted > 0) {
		const marker = `[${omitted} earlier or oversized message${omitted === 1 ? "" : "s"} omitted]`;
		const markerChars = marker.length + (lines.length > 0 ? 1 : 0);
		if (usedChars + markerChars <= availableChars) lines.splice(1, 0, marker);
	}

	return [header, ...lines, footer].join("\n");
}
