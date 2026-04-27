import chalk from "chalk";

import type { SimulationResult } from "../compiler/schema.js";
import { formatProgramError } from "./events.js";

export function renderTimeline(result: SimulationResult): string {
  return result.events
    .slice()
    .sort((left, right) => left.tick - right.tick)
    .map((event) => {
      const chain = event.triggered_by ? ` <- ${event.triggered_by}` : "";
      const programError = formatProgramError(event);
      const detail = programError ? ` ${programError}` : "";
      return `${chalk.cyan(`T${event.tick}`)} ${event.persona_label} (${event.agent_id}) ${event.action} ${event.outcome}${detail}${chain}`;
    })
    .join("\n");
}
