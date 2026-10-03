/**
 * Fix with AI (R3.1, R6.19): portable per-finding fix prompts and the consolidated "Fix All" task. The dashboard, the
 * REST API, the CLI, and MCP all build prompts through these functions.
 */
export {
  buildFixPrompt,
  buildFixPrompts,
  commentFixPrompt,
  COMMENT_FIX_PROMPT_CAP,
  cursorDeepLink,
  CURSOR_DEEPLINK_MAX,
  FIX_AGENT_LABEL,
  FIX_AGENTS,
  fixPromptBody,
  fixPromptHeader,
  isFixAgent,
  type FixAgent,
  type FixContext,
  type FixFinding,
  type FixPromptSet,
} from "./prompt";
export { loadFindingFix, toFixFinding, type FindingFix, type FixFileReader } from "./context";
export { buildFixAllTask, DEFAULT_FIX_ALL_MIN_CONFIDENCE, MAX_FIX_ALL_FINDINGS, type FixAllItem, type FixAllTask } from "./fix-all";
