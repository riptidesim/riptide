import chalk from "chalk";

import type { SimulationResult } from "../compiler/schema.js";

export function renderSummary(result: SimulationResult): string {
  const { run_config, summary } = result;
  const utilizationColor = summary.final_utilization >= 0.85 ? chalk.red : chalk.green;
  const debtColor = summary.total_bad_debt > 0 ? chalk.red : chalk.green;

  return [
    chalk.bold("Riptide Simulation Summary"),
    `Scenario: ${run_config.scenario}`,
    `Agents: ${run_config.agents} | Ticks: ${result.total_ticks} | Seed: ${result.seed}`,
    `Final TVL: ${chalk.green(summary.final_tvl.toFixed(2))}`,
    `Final Utilization: ${utilizationColor(summary.final_utilization.toFixed(2))}`,
    `Liquidations: ${summary.total_liquidations}`,
    `Bad Debt: ${debtColor(summary.total_bad_debt.toFixed(2))}`,
    `Agent Status Counts: active=${summary.agents_active}, liquidated=${summary.agents_liquidated}, depleted=${summary.agents_depleted}`,
    `Largest Drawdown: ${summary.largest_single_tick_drawdown.toFixed(4)}`,
    "Simulation Boundaries:",
    ...result.simulation_boundaries.map((boundary) => `- ${boundary}`)
  ].join("\n");
}
