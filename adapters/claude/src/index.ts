export { buildClaudeBundle, supportedVersion, type ClaudeBundle, type ClaudeBundleInput } from "./bundle.js";
export { configureClaudeProfile, observeClaudeInstallation, validateClaudeBundle, type ClaudeLifecycle, type ClaudeScope } from "./profile.js";
export { runClaudeHook, workerBriefEnvironment, type ClaudeHookResult } from "./runtime.js";
export { assessClaudeActivation, claudeCapabilities, parseClaudeTrace, type ClaudeSessionObservation } from "./trace.js";
export { createClaudeBackend, executeClaudeSession, type ClaudeBackendOptions, type ClaudeSessionOptions } from "./backend.js";
export type { ClaudeProfile } from "./process.js";
