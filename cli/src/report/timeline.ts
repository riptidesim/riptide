import chalk from "chalk";

import type { SimulationResult } from "../compiler/schema.js";

export function renderTimeline(result: SimulationResult): string {
  return result.events
    .slice()
    .sort((left, right) => left.tick - right.tick)
    .map((event) => {
      const chain = event.triggered_by ? ` <- ${event.triggered_by}` : "";
      return `${chalk.cyan(`T${event.tick}`)} ${event.persona_label} (${event.agent_id}) ${event.action} ${event.outcome}${chain}`;
    })
    .join("\n");
}
