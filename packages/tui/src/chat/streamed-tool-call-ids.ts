import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";

/** Keep live tool cards when providers or the agent mint ids after arguments have streamed. */
export function reconcileStreamedToolCallIds(
	content: AssistantMessage["content"],
	previous: Map<number, string>,
	migrate: (oldId: string, newId: string) => void,
	retain?: (id: string, call: ToolCall) => void,
): void {
	const current = new Map<number, string>();
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "toolCall") current.set(index, block.id);
	}
	for (const [index, id] of current) {
		const oldId = previous.get(index);
		if (oldId === undefined || oldId === id) {
			previous.set(index, id);
			continue;
		}
		// Siblings can temporarily share an empty/provider id. Its last owner keeps
		// the existing card; splitting one sibling must not steal the other's card.
		let stillOwned = false;
		for (const [otherIndex, otherId] of current) {
			if (otherIndex !== index && (otherId === oldId || previous.get(otherIndex) === oldId)) {
				stillOwned = true;
				break;
			}
		}
		if (stillOwned) {
			for (const [keeperIndex, keeperId] of current) {
				const keeper = content[keeperIndex];
				if (keeperId === oldId && keeperIndex !== index && keeper?.type === "toolCall") retain?.(oldId, keeper);
			}
		} else {
			migrate(oldId, id);
		}
		previous.set(index, id);
	}
}
