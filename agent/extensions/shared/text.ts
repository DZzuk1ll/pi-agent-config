import { StringDecoder } from "node:string_decoder";

export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const TOOL_OUTPUT_MAX_LINES = 2_000;

const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8ByteLength(value) <= maxBytes) return value;

	let low = 0;
	let high = value.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		if (utf8ByteLength(value.slice(0, midpoint)) <= maxBytes) low = midpoint;
		else high = midpoint - 1;
	}
	let end = low;
	const last = value.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return value.slice(0, end);
}

function truncateUtf8Tail(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8ByteLength(value) <= maxBytes) return value;

	let low = 0;
	let high = value.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		if (utf8ByteLength(value.slice(value.length - midpoint)) <= maxBytes) low = midpoint;
		else high = midpoint - 1;
	}
	let start = value.length - low;
	const first = value.charCodeAt(start);
	if (first >= 0xdc00 && first <= 0xdfff) start++;
	return value.slice(start);
}

export function sanitizeForDisplay(value: string): string {
	return value
		.replace(ANSI_OSC_RE, "")
		.replace(ANSI_CSI_RE, "")
		.replace(CONTROL_RE, "�");
}

export function tailLines(value: string, limit: number): string {
	const normalized = Math.max(1, Math.min(500, Math.floor(limit)));
	const lines = value.split("\n");
	return lines.length <= normalized ? value : lines.slice(-normalized).join("\n");
}

export interface BoundedTextOptions {
	maxBytes?: number;
	maxLines?: number;
	fullOutputPath?: string;
}

export interface BoundedTextResult {
	text: string;
	truncated: boolean;
	originalBytes: number;
	originalLines: number;
}

export function boundToolText(value: string, options: BoundedTextOptions = {}): BoundedTextResult {
	const maxBytes = Math.max(1, options.maxBytes ?? TOOL_OUTPUT_MAX_BYTES);
	const maxLines = Math.max(1, options.maxLines ?? TOOL_OUTPUT_MAX_LINES);
	const originalBytes = utf8ByteLength(value);
	const originalLines = value.length === 0 ? 0 : value.split("\n").length;
	if (originalBytes <= maxBytes && originalLines <= maxLines) {
		return { text: value, truncated: false, originalBytes, originalLines };
	}

	let noticeLines = [
		`[output truncated: ${originalBytes} bytes, ${originalLines} lines]`,
		...(options.fullOutputPath ? [`[full output: ${options.fullOutputPath}]`] : []),
	].slice(0, maxLines);
	let marker = noticeLines.join("\n");
	if (utf8ByteLength(marker) > maxBytes) {
		marker = truncateUtf8(marker, maxBytes);
		noticeLines = marker.length === 0 ? [] : marker.split("\n");
	}
	const markerWithBreaks = marker.length > 0 ? `\n${marker}\n` : "";
	const availableBytes = Math.max(0, maxBytes - utf8ByteLength(markerWithBreaks));
	const headByteBudget = Math.floor(availableBytes * 0.55);
	const tailByteBudget = availableBytes - headByteBudget;
	const contentLineBudget = Math.max(0, maxLines - noticeLines.length);
	const headLineBudget = Math.ceil(contentLineBudget * 0.55);
	const tailLineBudget = contentLineBudget - headLineBudget;

	let headSource = value;
	let tailSource = value;
	if (originalLines > contentLineBudget) {
		const lines = value.split("\n");
		headSource = lines.slice(0, headLineBudget).join("\n");
		tailSource = tailLineBudget > 0 ? lines.slice(-tailLineBudget).join("\n") : "";
	}
	const head = truncateUtf8(headSource, headByteBudget);
	const tail = truncateUtf8Tail(tailSource, tailByteBudget);
	const text = markerWithBreaks ? [head, marker, tail].filter((part) => part.length > 0).join("\n") : truncateUtf8(value, maxBytes);
	return { text, truncated: true, originalBytes, originalLines };
}

/** Keeps a valid UTF-8 tail without retaining an unbounded stream. */
export class Utf8TailBuffer {
	private readonly decoder = new StringDecoder("utf8");
	private readonly maxBytes: number;
	private value = "";
	private omittedBytes = 0;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	push(chunk: Buffer | string): string {
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.value += text;
		const bytes = utf8ByteLength(this.value);
		if (bytes > this.maxBytes) {
			const before = bytes;
			this.value = truncateUtf8Tail(this.value, this.maxBytes);
			this.omittedBytes += before - utf8ByteLength(this.value);
		}
		return text;
	}

	finish(): void {
		const rest = this.decoder.end();
		if (rest) this.push(rest);
	}

	view(): { text: string; omittedBytes: number } {
		return { text: this.value, omittedBytes: this.omittedBytes };
	}
}
