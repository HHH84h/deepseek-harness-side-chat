/**
 * Test-only LLM adapter. It never talks to a provider: it records the exact
 * `GenerateOptions` the harness assembles (messages + tools) and streams one
 * fixed text block. Records go to $DSH_FAKE_LLM_LOG as JSON lines.
 */
import { appendFileSync } from "node:fs";

const PROVIDER = "fake-side";
const MODEL = "fake-1";

function record(options) {
	const file = process.env.DSH_FAKE_LLM_LOG;
	if (file === void 0) return;
	appendFileSync(
		file,
		`${JSON.stringify({
			provider: options.provider,
			model: options.model,
			messages: options.messages,
			tools: (options.tools ?? []).map((tool) => tool.name),
			system: options.system,
		})}\n`,
	);
}

const adapter = {
	providerInfo(provider) {
		return { id: provider, name: "Fake side provider" };
	},
	providerRetryPolicy() {
		return void 0;
	},
	imageRequestPricing() {
		return void 0;
	},
	imageRequestTarget(_provider, _model, image) {
		return image;
	},
	async listModels(provider) {
		return [{ provider, id: MODEL, name: "Fake 1" }];
	},
	async resolveModel(provider, model) {
		return { provider, id: model, name: model, context: { contextWindow: 200000 } };
	},
	async prepareCall(provider, model) {
		return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
	},
	async *stream(options) {
		record(options);
		const all = JSON.stringify(options.messages ?? []);
		if (all.includes("SLOW-TURN")) await new Promise((resolve) => setTimeout(resolve, 1500));
		const text = "FAKE-REPLY";
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "usage", usage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 7, cacheWriteTokens: 3, totalTokens: 178 } };
		yield { type: "finish", reason: "stop" };
	},
};

export const inject = ["llm"];
export function apply(ctx) {
	ctx.llm.registerAdapter([PROVIDER], adapter);
}
