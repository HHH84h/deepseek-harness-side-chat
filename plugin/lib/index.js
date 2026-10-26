/**
 * Plugin entry for `/side`.
 *
 * The host implementation lives in `host.js` so the production entry contains
 * no self-test, phase driver, barrier, or test-only command. Tests mount their
 * own driver package and call the same exported host implementation.
 */
import { createSideChatHost } from "./host.js";

export { name, inject, firstQuestionText, formatSessionMention, sideSessionIdFor } from "./host.js";

export function apply(ctx) {
	const host = createSideChatHost(ctx);
	ctx.effect(() => async () => {
		await host.dispose?.();
	}, "side-chat host lifetime");
}
