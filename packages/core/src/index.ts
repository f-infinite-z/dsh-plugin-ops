export { resolveDshPaths, MEMORY_DIR_NAME, MEMORY_FILENAME, type DshPaths } from './paths.js'
export { readProfileManifest, profileBundles, registryDependencies, resolveBundles, anchorFiles, type ProfileManifest, type ResolvedBundle, type BundleResolution } from './profile.js'
export { packageDirFromAnchor, packageDirFromAnchors, readPackageManifest, type PackageManifest } from './package-tree.js'
export { readLockedDirectDeps, hasLockfile, type LockedDirectDeps } from './lockfile.js'
export { appendMemory, lastSuccessSnapshot, recentEvents, diffSnapshots, type MemoryEvent } from './memory.js'
export { scanProfile, ScanError, declaredRegistryNames, type ScanInput } from './scan.js'
export { renderHuman, renderJson, reportOk, countSeverities } from './report.js'
export { readPatchFile, appendDisabledRow, removeDisabledRow, patchFileExists, PROFILE_PATCH_FILENAME, type PatchRow, type PatchFileState, type PatchWriteResult } from './patch-layer.js'
export { allVisibleRows, rowIdsForPackage, type RowRef } from './rows.js'
export { pnpmBin, runCommand, runPnpm, alignToLockfile, disableRow, type RunResult, type AlignResult, type DisableResult } from './fix.js'
export { checkOutdated, type OutdatedState, type OutdatedEntry } from './outdated.js'
export { readOpsConfig, applyConfig, DEFAULT_CONFIG_FILENAME, type OpsConfig, type RuleOverride } from './config.js'
export { CORE_PACKAGES } from './peers.js'
export { ruleBundleDeclaration, ruleDependencyDrift, ruleSessionMemory, ruleRegistryVersion, type RuleContext } from './rules.js'
export { rulePeerGap, rulePeerDrift } from './peers.js'
export { rulePatchResolution } from './patchres.js'
export { ruleStructure } from './structure.js'
export { runSelfTest, type SelfTestResult } from './selftest.js'
export { handlePanelApi, PanelApiError, isScanError, type PanelApiOptions, type RowView } from './panel-api.js'
export { resolveModelConfig, lookupSecret, OpenAiCompatibleChannel, buildSystemPrompt, buildChatContext, type ChatMessage, type ChatContext, type ChatReply, type ModelChannel, type ResolvedModelConfig } from './chat.js'
export {
  listKnowledge,
  readKnowledge,
  writeKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  retrieveKnowledge,
  bm25Search,
  tokenize,
  recordFixKnowledge,
  formatKnowledgeContext,
  buildDepositPrompt,
  parseDepositReply,
  resolveEmbeddingConfig,
  type KnowledgeEntry,
  type KnowledgeHit,
  type KnowledgeSource,
  type KnowledgeInput,
  type EmbeddingConfig,
  type DepositDraft,
} from './knowledge.js'
export type { Severity, RuleId, Finding, Fix, PackageState, PackageSnapshot, SnapshotDiffEntry, MemoryInfo, ScanReport } from './types.js'
