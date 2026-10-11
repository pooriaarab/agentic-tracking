export { VERSION } from "./version.js";
export {
  defineBrand,
  createLogger,
  GuardError,
  VendorError,
  createGuards,
  LocalRouterAdapter,
  HttpRouterAdapter,
  recordCost,
  getCostReport,
  resetCosts,
  createDryRunResult,
  dispatchText,
  summarizeText,
} from "./core.js";
export type {
  BrandConfig,
  LogLevel,
  Logger,
  LoggerOptions,
  CapsConfig,
  QuietHoursConfig,
  GuardsConfig,
  Guards,
  DispatchReceipt,
  RouterAdapter,
  HttpRouterOptions,
  CostEntry,
  CostReport,
  DispatchOptions,
  DispatchResult,
  TopWord,
  TextSummary,
  SummarizeOptions,
} from "./core.js";

import { defineBrand, type BrandConfig } from "./core.js";
import { VERSION } from "./version.js";

export * from "./tracking.js";
export const DEFAULT_BRAND: BrandConfig = defineBrand({
  name: "Agentic tracking", command: "agentic-tracking",
  description: "Attribute calls to lines and credit leads.",
  keywords: ["call-tracking", "attribution", "agentic-suite", "claude-code", "codex", "cli", "mcp"],
  version: VERSION,
});
