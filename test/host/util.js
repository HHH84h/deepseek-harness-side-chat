/** Test-only reporting and fake-provider log readers. */
import { readFileSync } from "node:fs";

/** Print one JSON line and never throw into the host. */
export function report(line) {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function requestText(messages) {
	const parts = [];
	for (const message of messages ?? []) {
		const content = message?.content;
		if (typeof content === "string") parts.push(content);
		if (Array.isArray(content)) {
			for (const block of content) if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** Read the fake adapter's recorded requests. */
export function readRequests(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/**
 * Real-path context test: the harness runs full turns against a recording fake
 * provider, so assertions read the exact messages and tool schemas the model
 * would receive.
 */
