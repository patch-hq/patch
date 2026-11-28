import { cutoffMs } from './cleanup.js';
import { removeRetiredNativeCopies } from './retiredNativeCopies.js';
import { removeRetiredTelegramFolder } from './retiredTelegramThread.js';
import type { ElevenLabsTtsModel } from './audio/elevenlabs.js';
import { applyOwnSettings, ownConfigFile, type OwnConfigFile } from './providerSettings.js';
import { AccountsClient, ServerApiClient } from './accountsClient.js';
import { ServerEventsClient } from './serverEventsClient.js';
import { HARNESS_TRAITS } from './harnesses.js';
import {
  adapterForModel,
  type ProviderAdapters,
  type TurnAccountHint,
} from './providerAdapters.js';
import { ACP_BACKEND_ID, AcpRegistry } from './acpRegistry.js';
import { AcpAccounts, type AcpRoute } from './acpAccounts.js';
import type { AcpLogin } from './acpLogin.js';
import { AcpBackend } from './acpBackend.js';
import { CodexAccounts, CODEX_BACKEND_ID } from './codexAccounts.js';
import { createSleepGuard } from './sleepGuard.js';
import { createSleepWatch } from './sleepWatch.js';
import { CodexBackend } from './codexBackend.js';
import { CodexSessions } from './codexSessions.js';
import { discoverClaudeMcpServers } from './claudeConfigMcp.js';
import { ModelEndpointRegistry } from './modelEndpoints.js';
// Entry point for the patch-daemon process.
//
// Wires together: chat_state map, ChatRunner/Daemon, loopback HTTP control
// (UDS), TCP /healthz, and the OUTBOUND server-daemon WebSocket link (the
// host dials into the patch-server's /ws and authenticates with its
// EdDSA-JWT daemonKey from ~/.patch/daemon.key).

import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { acquireHomeLock, type HomeLock } from './homeLock.js';
import { detachDurableTurns, type DurableTurnConfig } from './durableTurn.js';
import { SHUTDOWN_DEADLINE_MS, shutdownThenExit } from './shutdownDeadline.js';
import { runShutdownSteps, type StepReport } from './shutdownSteps.js';
import { linkLegacySocket, isNamedPipe } from './legacySocket.js';
import {
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  chmodSync,
  realpathSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import pino from 'pino';
import { installCrashGuard } from './crashGuard.js';
import {
  Daemon,
  chatInputToSendOptions,
  FolderNotFoundError,
  NoModelCatalogueError,
  ChatNotFoundError,
  AttachmentChatNotFoundError,
  type OAuthCheckResult,
} from './chatRunner.js';
import { ChatMoveError } from './chatMove.js';
import { expandHome } from './expandHome.js';
import { gitDirtyPaths } from './git-dirty.js';
import { isInsideGitWorkTree } from './git-presence.js';
import { listFilesRecursive } from './files-recursive.js';
import { agentHeldSession, createClaudeSessionProbe, type SessionProbe } from './history.js';
import type {
  ChatErrorCode,
  McpServerConfig,
  WireEvent,
  RateLimitWindow,
  PatchActivityResponseEvent,
  PatchSearchChatsResponseEvent,
  VoiceTimersResponseEvent,
  ProviderId,
  LimitBehaviour,
} from '@patch/wire';
import {
  BACKGROUND_ACCOUNT_AUTO,
  bedrockCapResetsAt,
  bedrockSpentThisMonth,
  limitBehaviourFromAutoResume,
  providerForSessionId,
} from '@patch/wire';
import {
  DEFAULT_SHARED_SETTINGS,
  isHostAddressedSurfaceEvent,
  OUT_OF_BAND_SEQ,
  ProviderKeyId,
  type SettingsAdoptRequestEvent,
  type SettingsAdoptResponseEvent,
  type SettingsSnapshotEvent,
  type OwnSetting,
  PROVIDERS,
  type ProviderDescriptor,
  type HarnessId,
  acpSettingsId,
  type AcpLoginRequestEvent,
  type AcpLoginUpdateEvent,
  type AccountStrategy,
  type SharedSecrets,
  type ProviderAccountsKey,
  ACCOUNT_PROVIDERS,
  providerAccountKind,
  providerForBackendId,
  type SharedSettings,
  type SharedSettingsPatch,
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_MODEL,
  DEFAULT_MEETING_RESEARCH_SECONDS,
  DEFAULT_MEETING_NOW_PROMPT,
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_REFUSAL_LIMIT,
  DEFAULT_GOAL_STRINGENCY,
  QUESTION_EXPIRY_SECONDS_DEFAULT,
  DEFAULT_QUESTION_EXPIRED_PROMPT,
  refusingRateLimitScope,
  rejectedRateLimitScope,
} from '@patch/wire';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { loadConfig, patchHomeFrom, type HostSpeechBackend } from './config.js';
import { buildControl } from './control.js';
import {
  createRemoteSpawnCoordinator,
  describeSpawnFailure,
  type RemoteSpawnRequest,
} from './remote-spawn.js';
import { createRemoteRelayCoordinator, RemoteRelayError } from './remote-relay.js';
import { createChatDelivery } from './chatDelivery.js';
import { ArtifactAutoRepublisher, ArtifactPublisher } from './artifacts.js';
import { PadClient } from './pads.js';
import { RemoteJobsStore } from './jobs-interface.js';
import { QueuePullClient } from './queuePull.js';
import {
  assessHostHealth,
  HOST_HEALTH_INTERVAL_MS,
  isEndpointModel,
  isRetiredLocalSessionId,
  providerDescriptor,
  parseAcpModel,
  providerForModel,
} from '@patch/wire';

/**
 * Where chats on the retired local-model loop kept their history (Codex's
 * format). Read for those chats' history and search only; nothing writes it.
 */
const retiredLocalHistoryDir = (patchHome: string): string => join(patchHome, 'local-history');
import type { ChatInputEvent, GoalStringency } from '@patch/wire';
import { DEFAULT_SMALL_JOB_MODELS } from '@patch/wire';
import { createMetaStore } from './meta.js';
import { readAccountExhaustion, writeAccountExhaustion } from './accountAvailabilityStore.js';
import {
  bootstrapClaudeOAuth,
  makeResolveOAuth,
  readDaemonKey,
  registerHost,
  writeDaemonKey,
  type ClaudeTokenValidator,
} from './registration.js';
import {
  loadLegacyClaudeOAuth,
  seedPatchStore,
  readPatchStore,
  writePatchStore,
  setAccountOrganization,
  type LoadClaudeOAuthOptions,
} from '@patch/auth';
import type { HostAccountEvent } from '@patch/wire';
import { DEFAULT_WATCH_CHECK_IN_MINUTES, DEFAULT_WATCH_CHECK_IN_PROMPT } from '@patch/wire';
import {
  createMockSdkBackend,
  createRealSdkBackend,
  forgetClaudeExecutable,
  setClaudeInstallGate,
  setClaudeEnsure,
  type SdkBackend,
} from './sdkBackend.js';
import { makeTitleGenerator } from './titleGen.js';
import {
  AWS_SIGN_IN_EXPIRED,
  BEDROCK_CAP_REACHED,
  BedrockSignIn,
  bedrockCapRefusal,
  bedrockCappedWith,
  bedrockRunOf,
  pendingBedrockSpendUsd,
  checkAwsProfile,
  claudeAccountsIdentity,
  readAwsProfiles,
  withBedrockSpend,
} from './bedrockAccounts.js';
import { runClaudeOneShot, type ClaudeOneShotDeps } from './claudeOneShot.js';
import { makeStatusGenerator } from './statusGen.js';
import { MeetingManager, MeetingNotice, type MeetingPrompts } from './meeting.js';
import {
  makeMeetingAnalyser,
  makeMeetingCorrector,
  makeMeetingResearcher,
  makeMeetingWriteup,
} from './meetingGen.js';
import { makeGoalEvaluator } from './goalEval.js';
import { makeToolRunSummarizer } from './toolRunGen.js';
import { makeBranchSendBackSummarizer } from './branchSendBackGen.js';
import { makeRecurrenceTranslator } from './recurrenceTranslate.js';
import { makeLinkSummariser } from './linkSummary.js';
import {
  ensureSpecialThreads,
  specialThreadFolder,
  appendBroadcast,
  isBroadcastSelfLoop,
  readPendingBroadcasts,
  flushBroadcasts,
  buildBroadcastNote,
  threadForChannel,
  BROADCAST_SIDECAR_THREADS,
  SPECIAL_THREAD_IDS,
  type SpecialThreadId,
} from './specialThreads.js';
import { BUILD_TARGET, BUILT_AT, GIT_SHA, VERSION } from './version.js';
import {
  WATCHDOG_FLAG,
  currentVersionOf,
  recordAlive,
  runWatchdog,
  takeUpdateFailure,
} from './updateProbation.js';
import { countUpdateAttempt, recordShutdown, recordStart, signalContext } from './runDiag.js';
import {
  waitForCallsToEnd,
  applyUpdate,
  checkForUpdate,
  createArtifactWait,
  describeUpdateRefusal,
  updateWorkRoot,
  createUpdateGate,
  pruneStaged,
  sweepUpdateWorkDirs,
  stageUpdate,
  stagedBuild,
  requestUpdate,
} from './selfUpdate.js';
import { updateClaudeCli } from './claudeCliUpdate.js';
import {
  AccountRotation,
  parseLimitResetsAt,
  spentRefusal,
  type FailoverAccount,
  type RouteOptions,
  type RunOnAccountWithCredit,
} from './accountFailover.js';
import { AccountUsageTracker } from './accountUsage.js';
import { CreditResume } from './creditResume.js';
import { resolveClaudeExecutable } from './claudeExecutable.js';
import { installClaudeCode, installFailure } from './claudeInstall.js';
import { localKeyPath, mintLocalKey } from './localKey.js';
import {
  CLAUDE_BACKEND_ID,
  claudeBackendEntry,
  describeHost as buildHostDescription,
} from './host.js';
import { createSleepDetector } from './linkDropCause.js';
import { createServerLink } from './serverLink.js';
import { RecordImport } from './recordImport.js';
import { Outbox } from './outbox.js';
import { createHealthSampler } from './healthReport.js';
import { checkLaunchPath } from './launchPath.js';
import { JobRuns } from './jobExec.js';
import { handleHostWake } from './hostWake.js';
import { rotateLog } from './logRotate.js';
import { handleHookCheck } from './hookCheck.js';
import { FolderRegistry } from './folders.js';
import { ModelCatalog } from './modelCatalog.js';
import { handleBackgroundTaskStatsRequest } from './backgroundTaskStats.js';
import { StrayProcessTracker, handleStrayProcessesRequest } from './strayProcesses.js';
import {
  handleWatchCheckInRequest,
  handleWatchOutputRequest,
  handleWatchListRequest,
  handleWatchStopRequest,
} from './watchRequests.js';
import { handleDelegateControlRequest } from './delegateControlRequests.js';
import { HostStateStore } from './hostState.js';
import { AudioRelayBridge } from './audio-relay-bridge.js';
import { webBotAuthFromServer } from './webBotAuth.js';
import { appBrowserLink } from './appBrowser.js';
import {
  browserToolsEnabledOf,
  enabledMcpServers,
  seedMcpServers,
  withBrowserToolsEnabled,
} from './mcpServers.js';
import { getPatchToolsPrompt, toolsPromptOverride } from './toolsPrompt.js';
import { patchToolDescriptions } from './mcp.js';
import { ComponentManager, ComponentNotOfferedError, componentRuntimeDir } from './components.js';
import { provisionSidecarRuntime, resolveUv } from './audio/sidecarRuntime.js';
import { bundledBuildInfo, bundledSidecarDir } from './installPaths.js';
import {
  VoiceComponentMissingError,
  voiceComponentDir,
  voiceComponentInstalled,
  voiceLocations,
} from './voiceComponent.js';
import { TerminalSessions } from './terminal.js';
import { handleHostFilesRequest } from './hostFiles.js';
import { McpApps, stdioConnector } from './mcpApps.js';
import { handleVoiceprintRequest } from './voiceprints.js';
import { RecentVoices, SpeakerId, speakerModelPath } from './audio/speakerId.js';
import { HostSearchManager } from './hostSearch.js';
import { handleBlobRequest } from './blobFetch.js';
import { ToolLogSink } from './toolLog.js';
import { ChatTokenReader, UsageHistoryStore } from './usageHistory.js';
import { ProviderKeyError, ProviderKeyStore, providerKeysPath } from './providerKeys.js';
import { createSecretsStore, InvalidSecretKeyError, type SecretsStore } from './secrets.js';
import {
  claudeHomeFromProjectsRoot,
  deleteClaudeMemory,
  setClaudeMemory,
  InvalidMemoryRefError,
  InvalidSettingsJsonError,
  listClaudeMemories,
  MemoryNotFoundError,
  readClaudeSettingsJson,
  writeClaudeSettingsJson,
} from './claudeSettings.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CALL_RESUMED_NOTE, startAudioServer, type AudioServerHandle } from './audio/server.js';
import { createVoiceReplyBridge } from './audio/replyBridge.js';
import { createManagerVoiceTools, type ManagerTimerRequest } from './audio/managerVoice.js';
import {
  ChatLookupError,
  createChatLookup,
  MANAGER_CHAT_ID,
  type ChatEntry,
} from './audio/chatLookup.js';
import { createSmartTurnDetector, pcmFromWav, type TurnDetector } from './audio/smartTurn.js';
import { createChatVoice, voiceLocalId, voiceTag } from './audio/chatVoice.js';
import type { StartMessage } from './audio/voiceAgent.js';
import { makeVoiceCatchUp } from './audio/voiceCatchUp.js';
import {
  fetchConversationCharge,
  fetchPlanCredits,
  type PlanCredits,
} from './audio/elevenlabs-usage.js';
import { createVoiceLedger } from './audio/voiceLedger.js';
import {
  createWhisper,
  validateWhisperCredentials,
  UnsupportedClipFormatError,
  LocalWhisperBackend,
  GroqWhisperBackend,
  UnconfiguredWhisperBackend,
  type WhisperBackend,
} from './audio/whisper.js';
import { ParakeetWhisperBackend } from './audio/parakeet.js';
import { createSpeechToTextResolver } from './audio/stt-engines.js';
import { handleDirectSpeak, handleDirectTranscribe } from './audio/direct-speech.js';
import { ParakeetLiveRecognizer } from './audio/parakeet-live.js';
import { createKokoro, validateKokoroModel } from './audio/kokoro.js';
import { createElevenLabs, createRoutedTts, type ElevenLabsVoice } from './audio/elevenlabs.js';
import {
  createDictationTranscribers,
  pickDictationTranscriber,
  type DictationTranscribers,
} from './audio/hosted-stt.js';
import { ElevenLabsScribeBackend, ScribeVoiceMap } from './audio/elevenlabs-stt.js';
import {
  AssemblyAiMeetingBackend,
  DeepgramMeetingBackend,
  type DiarisedClipEngine,
} from './audio/meeting-stt.js';
import { costCall, costDirectCall } from './audio/voiceCost.js';
import {
  createSileroVadFactory,
  validateVadModel,
  MockVad,
  DEFAULT_VAD_CONFIG,
  type Vad,
} from './audio/vad.js';
import { clipHasSpeech } from './meetingSpeechGate.js';
import {
  DEFAULT_VOICE_AGENT,
  DEFAULT_VOICE_CONFIG,
  voiceKeyMissingMessage,
  voiceSurfacesMissingKey,
  dictationEngineFor,
  type DictationEngine,
  type VoiceAgentSetting,
  type VoiceConfig,
  type VoiceKeys,
  type VoiceTones,
} from '@patch/wire/audio';
import { VoiceCatalogStore } from './audio/voiceCatalog.js';
import type { FastifyInstance } from 'fastify';

/**
 * How often to re-warm Kokoro while the host is idle (spec/07 § Latency —
 * "Kokoro pre-warm at boot"). Well inside the window over which an idle model
 * gets paged out on a busy box.
 */
const KOKORO_KEEP_WARM_MS = 8 * 60_000;

/**
 * Test-only boot hook (mirrors the `enableTestHooks` convention in
 * serverLink.ts). Never populated by the real CLI entry at the bottom of this
 * file — `main()` is called there with no arguments, so `testHooks` is always
 * `undefined` in production and every line below that reads it is a no-op.
 * Exists solely so an in-process integration test can (a) obtain the real
 * `shutdown()` closure to tear the host down cleanly instead of going
 * through the `process.exit`-calling control-IPC path, and (b) obtain the
 * live `daemon`/`folderRegistry`/`secretsStore` graph to assert against.
 */
export interface MainTestHooks {
  onReady?: (handle: {
    shutdown: () => Promise<void>;
    daemon: Daemon;
    folderRegistry: FolderRegistry;
    secretsStore: SecretsStore;
    /** The control-IPC Fastify app — lets a test `app.inject(...)` directly. */
    app: FastifyInstance;
    /**
     * The SDK backend this host is running against — under `SDK_BACKEND=mock`
     * (every test boot) this is a `MockSdkBackend`, letting a test `enqueue()`
     * a scripted envelope (e.g. a `rateLimit` report) ahead of a chat turn.
     */
    sdkBackend: SdkBackend;
  }) => void;
  /**
   * Replaces the Anthropic call that checks a submitted token (spec/10 §
   * Validating a pasted token). Present ONLY so a test can drive both outcomes
   * without a network — a test must never reach the real API with a real
   * credential. Undefined in production, where the real check runs.
   */
  validateClaudeToken?: ClaudeTokenValidator;
  /**
   * Replaces running Claude Code's installer on a host that has none (spec/02 §
   * Agent backends). Present ONLY so a test that boots a real backend never
   * downloads and installs Claude Code onto the machine running the tests.
   */
  installClaudeCode?: (home: string) => Promise<import('./claudeInstall.js').ClaudeInstallResult>;
  /** Shortens the wait between automatic Claude Code install retries. */
  claudeRetryDelaysMs?: number[];
  /** Where the host's log lines go instead of stdout — lets a test read what boot logged. */
  logStream?: import('pino').DestinationStream;
  /** Replaces the socket to Gemini Live, so a test can play the model without a network. */
  geminiWsCtor?: new (url: string) => import('ws').WebSocket;
  /** Replaces the network for the voice agent catalog's reads (voiceCatalog.ts). */
  voiceCatalogFetch?: import('./audio/voiceCatalog.js').CatalogFetch;
}

/**
 * Run a command to completion, capturing its output. Backs the on-demand
 * provisioning of a voice sidecar's Python runtime (§ ComponentManager below).
 * Never throws on a non-zero exit — the caller decides what a failure means and
 * reports it with what the command printed.
 */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Where `uv` might already be on this host, before one is installed for it:
 * a previous provision's copy, the user's own install, the usual system paths.
 */
function uvCandidates(patchHome: string): string[] {
  return [
    join(patchHome, 'tools', 'uv'),
    join(homedir(), '.local', 'bin', 'uv'),
    '/usr/local/bin/uv',
    '/opt/homebrew/bin/uv',
    '/usr/bin/uv',
  ];
}

/** Rejects with the listen error (EADDRINUSE) when something already holds the port. */
async function assertHealthzPortFree(host: string, port: number): Promise<void> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, host, () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

/** The provider keys a host cannot start without, given the speech engine its settings name. */
function speechRequiredKeys(
  backend: HostSpeechBackend,
): Partial<Record<'groq' | 'elevenlabs', string>> {
  if (backend === 'groq') return { groq: 'This host transcribes with Groq (the speech setting)' };
  if (backend === 'elevenlabs') {
    return { elevenlabs: 'This host transcribes with ElevenLabs (the speech setting)' };
  }
  return {};
}

export async function main(testHooks?: MainTestHooks): Promise<void> {
  const config = loadConfig({
    speechBackend: new HostStateStore(patchHomeFrom(process.env)).get().speechBackend,
  });
  // A host already running holds this port. Find out NOW: everything below
  // (hydrate re-sends each interrupted turn, the control socket is unlinked and
  // re-bound) acts on state the running host is using, so a second host that
  // One host per state directory, checked before anything is read or written,
  // and let go again if startup fails.
  mkdirSync(config.patchHome, { recursive: true });
  const homeLock = acquireHomeLock(config.patchHome);
  process.once('exit', () => homeLock.release());
  try {
    await startHost(config, homeLock, testHooks);
  } catch (err) {
    homeLock.release();
    throw err;
  }
}

async function startHost(
  config: ReturnType<typeof loadConfig>,
  homeLock: HomeLock,
  testHooks?: MainTestHooks,
): Promise<void> {
  // only discovered the clash at the real bind further down had already written
  // into the live host's chats and stolen its socket.
  if (config.healthzPort !== null) {
    await assertHealthzPortFree(config.healthzHost, config.healthzPort);
  }
  // The per-home lock was acquired by main before any state was read.
  mkdirSync(config.patchHome, { recursive: true });
  // spec/02 § Claude Code settings: settings.json sits one level above the
  // transcript-history root the host already resolves; reusing that root
  // means PATCH_CLAUDE_PROJECTS_ROOT sandboxes this too (see claudeSettings.ts).
  const claudeHome = claudeHomeFromProjectsRoot(config.claudeProjectsRoot);
  // settings.json is this host's own file (spec/02 § Claude Code settings):
  // read as it is each time it is reported, written only by a surface's edit.
  const claudeSettingsSnapshot = (): {
    settingsJson: string;
    memories: ReturnType<typeof listClaudeMemories>;
  } => ({
    settingsJson: readClaudeSettingsJson(claudeHome),
    memories: listClaudeMemories(config.claudeProjectsRoot),
  });

  // 0. Deployment credential gate (group H1, spec/11-deployment.md § Env): the
  // whisper backend's credential is validated EAGERLY, before OAuth, before the
  // healthz listener, before the /ws dial — "Validation must happen before any
  // attempt to serve requests. No silent fallback to a degraded mode." A `groq`
  // host with no GROQ_API_KEY would otherwise present a green audio WSS that
  // 500s the first real utterance — exactly the degraded mode the deployment
  // contract forbids. (This supersedes the earlier group-14 lazy-fail affordance.)
  //
  // The key itself may come from this host's provider-key store (spec/02
  // § Provider keys) — set from Settings → Hosts → Keys — which wins over the
  // environment. The store refuses to revoke the one Groq key a `groq` host has,
  // since the host would then not start to be given another.
  const providerKeys = new ProviderKeyStore({
    path: providerKeysPath(config.patchHome),
    env: {
      gemini: config.audio.geminiApiKey,
      openai: config.audio.openaiApiKey,
      elevenlabs: config.audio.elevenLabsApiKey,
      groq: config.audio.groqApiKey,
      deepgram: config.audio.deepgramApiKey,
      assemblyai: config.audio.assemblyaiApiKey,
    },
    requiredToStart: speechRequiredKeys(config.audio.whisperBackend),
  });
  validateWhisperCredentials({
    ...config.audio,
    groqApiKey: providerKeys.get('groq'),
    elevenlabsApiKey: providerKeys.get('elevenlabs'),
  });
  // spec/07 § Python sidecar lifecycle: KOKORO_MODEL_PATH must be validated at
  // startup — a missing model file aborts boot with a clear error rather than
  // silently 500ing the first TTS turn. Same fail-loud contract as Whisper.
  validateKokoroModel(config.audio);
  // spec/18 § Host + spec/07 Barge-in: when VAD_BACKEND=silero, the Silero
  // ONNX model must exist at startup — a missing model aborts boot rather than
  // silently disabling barge-in/end-of-utterance detection (NO SILENT FALLBACK).
  // An installed host's VAD model comes from the voice component, which may not
  // be installed yet: that is reported when a voice session asks for it, not by
  // refusing to boot a host whose chats do not need voice at all.
  if (bundledBuildInfo() === undefined || config.audio.vadModelPath !== undefined) {
    validateVadModel(config.audio);
  }

  const loggerOptions: import('pino').LoggerOptions = {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-patch-internal-token"]',
        'internalToken',
        '*.internalToken',
        'localKey',
        '*.localKey',
        'oauthAccessToken',
        '*.oauthAccessToken',
        'credential',
        'auth',
        'token',
        '*.token',
        // Group 12 (LOW-1): notification secrets.
        'fcmToken',
        '*.fcmToken',
      ],
      remove: true,
    },
  };
  const logger = testHooks?.logStream
    ? pino(loggerOptions, testHooks.logStream)
    : pino(loggerOptions);
  const launchMove = checkLaunchPath(config.patchHome, process.execPath);
  if (launchMove) {
    logger.warn(
      launchMove,
      'patch-daemon: host launch path changed — anything that allow-lists the old path (process killers, firewalls, permissions) must be updated or it will act on this host',
    );
  }
  // Why this start happened, and why the previous run stopped (runDiag.ts). The
  // record is re-derivable, so a failure here is logged loudly and never stops
  // the host.
  const noteShutdown = (via: string, caller: string, extra: Record<string, unknown> = {}): void => {
    logger.warn({ via, caller, ...extra }, 'patch-daemon: shutdown requested');
    try {
      recordShutdown(config.patchHome, { via, caller });
    } catch (err) {
      logger.error({ err }, 'patch-daemon: could not record the shutdown reason');
    }
  };
  process.on('uncaughtException', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EPIPE' && e.syscall === 'write') return;
    noteShutdown('uncaughtException', `crash: ${(err as Error)?.message ?? String(err)}`);
  });
  installCrashGuard(logger);
  try {
    const { reason, storm } = recordStart(config.patchHome, VERSION);
    logger.info(
      {
        startKind: reason.kind,
        version: VERSION,
        pid: process.pid,
        ppid: process.ppid,
        previousExit: reason.previousExit,
      },
      `patch-daemon: start — ${reason.kind}`,
    );
    if (storm) {
      logger.warn(
        { ...storm, startKind: reason.kind },
        `patch-daemon: restart storm — ${storm.count} starts in ${storm.windowMs / 1000}s`,
      );
    }
  } catch (err) {
    logger.error({ err }, 'patch-daemon: could not read or write the run record');
  }

  // 0. TCP /healthz — bound FIRST, before anything touches shared state. This
  //    port is the single-instance lock: a second host (launchd respawning
  //    while a survivor still runs) must die here with EADDRINUSE, not after it
  //    has hydrated chats, dialled the server and unlinked the live control
  //    socket — that ordering made every failed respawn interrupt the running
  //    turns ("Turn interrupted by restart") roughly every 10s.
  const tcp = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // spec/11 § Version reporting: an installed host reports its version,
      // the commit it was built from and the instant it was built.
      res.end(
        JSON.stringify({
          ok: true,
          version: VERSION,
          gitSha: GIT_SHA,
          builtAt: BUILT_AT,
          ...(BUILD_TARGET !== undefined ? { target: BUILD_TARGET } : {}),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const healthzPort = config.healthzPort;
  if (healthzPort !== null) {
    await new Promise<void>((resolve_, reject) => {
      tcp.once('error', reject);
      tcp.listen(healthzPort, config.healthzHost, () => resolve_());
    });
    logger.info(
      { host: config.healthzHost, port: healthzPort },
      'patch-daemon healthz listening on TCP',
    );
  } else {
    logger.info('patch-daemon healthz TCP listener off (local socket only)');
  }

  // 1. Resolve OAuth — log loudly on miss, but don't fail the host process:
  //    /healthz still has to come up so compose/healthcheck reports a green
  //    host and the surface can drive `claude login` via the
  //    daemon.unauthenticated event.
  // The credential store sits in the host's own state dir, beside daemon.key.
  // Deriving it from patchHome (PATCH_HOME) rather than hardcoding ~/.patch is what
  // keeps tests off the developer's real home — a disconnect driven through boot
  // wrote ~/.patch/claude-oauth.json on this host before it did.
  const oauthOpts: LoadClaudeOAuthOptions = {
    storePath: join(config.patchHome, 'claude-oauth.json'),
    ...(config.claudeCredentialsPath !== undefined ? { path: config.claudeCredentialsPath } : {}),
  };
  // First boot only: adopt whatever Claude Code left on this host into patch's own
  // store (`~/.patch/claude-oauth.json`), so the credential becomes something patch
  // can actually revoke from Settings. A no-op once the store exists — including
  // when it is deliberately empty, which is what makes a disconnect survive a
  // process or container restart (spec/10-auth.md § Claude subscription).
  try {
    const seeded = seedPatchStore(oauthOpts);
    if (seeded) logger.info({}, 'patch-daemon: seeded credential store from host credential');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'patch-daemon: credential store seed failed');
  }
  const oauth = bootstrapClaudeOAuth(oauthOpts);
  if (oauth.error) {
    // Not an error yet: a new host's accounts arrive in the first settings
    // snapshot seconds after connecting. It is re-checked, and reported as an
    // error if still missing, once that snapshot has been applied.
    logger.warn(
      { err: oauth.error },
      'patch-daemon: Claude OAuth not ready; waiting for the first account sync',
    );
  } else {
    logger.info({ source: oauth.credentials?.sourcePath }, 'patch-daemon: Claude OAuth loaded');
  }

  // 2. SDK backend selection. The mock writes a real JSONL transcript into the
  // SAME projects root the host's HistoryReader reads, so patch_history
  // paginates genuine persisted older events on the live stack.
  const rawSdkBackend: SdkBackend =
    config.sdkBackend === 'real'
      ? createRealSdkBackend()
      : createMockSdkBackend({
          claudeProjectsRoot: config.claudeProjectsRoot,
          // Hold a genuine working window per turn so stop-a-running-query is
          // exercisable against the live stack. Abortable: patch_stop unwinds
          // it immediately. Override with PATCH_MOCK_TURN_DELAY_MS.
          turnDelayMs:
            process.env['PATCH_MOCK_TURN_DELAY_MS'] !== undefined &&
            process.env['PATCH_MOCK_TURN_DELAY_MS'] !== ''
              ? Number(process.env['PATCH_MOCK_TURN_DELAY_MS'])
              : 2_500,
        });
  logger.info({ backend: config.sdkBackend }, 'patch-daemon: SDK backend selected');
  // spec/10 § Spending caps: every run on a Bedrock account, turn or one-shot,
  // reports what it cost; the server keeps the month's spend.
  const sdkBackend: SdkBackend = withBedrockSpend(
    rawSdkBackend,
    (accountId, costUsd) => {
      // `emit` is declared further down; nothing runs a turn before it is.
      emit({
        type: 'host.account_spend',
        hostId: selfHostId,
        accountId,
        costUsd,
        at: Date.now(),
        spendId: randomUUID(),
      });
      // The spend is owed to the server until it acknowledges it, and counted
      // against the cap meanwhile: the next turn must not start past it.
      syncBedrockCaps(sharedClaude);
    },
    (accountId) => {
      const a = sharedClaude.find((x) => x.id === accountId);
      if (a?.bedrock === undefined) return undefined;
      const now = Date.now();
      const pending = pendingBedrockSpendUsd(hostOutbox.pending(), a.id, now, a.bedrock.spendIds);
      return a.bedrock.monthlyCapUsd - bedrockSpentThisMonth(a.bedrock, now) - pending;
    },
  );

  // 3. Host registration: dial-in needs an EdDSA-JWT daemonKey. If absent,
  //    run the QR pairing flow (spec/10-auth.md "Host registration") and
  //    persist the surface-signed key to ~/.patch/daemon.key before connecting.
  let daemonKey = readDaemonKey(config.patchHome);
  if (daemonKey === undefined) {
    logger.warn('patch-daemon: no daemon.key found — starting QR registration');
    // `patch host start --pair <code>` (or PATCH_PAIR_NONCE) carries a nonce
    // pre-issued by the linked web Settings "add-daemon QR" — await it directly.
    const prePairedNonce = process.env['PATCH_PAIR_NONCE'];
    const reg = await registerHost({
      serverUrl: config.serverUrl,
      patchHome: config.patchHome,
      logger,
      ...(prePairedNonce !== undefined && prePairedNonce.length > 0 ? { prePairedNonce } : {}),
    });
    writeDaemonKey(config.patchHome, reg.daemonKey);
    daemonKey = reg.daemonKey;
    logger.info({ hostId: reg.hostId }, 'patch-daemon: registered, daemon.key written');
  }

  // The daemon.key is an EdDSA-JWT whose `sub` is the account public key (the
  // singleton accountId — server keys the account on the user public key). The
  // device control plane (F2) verifies device surface JWTs against this same
  // account key, since the device is paired under the same account. Read it
  // from the JWT payload (no signature check needed — we only need the claimed
  // subject; the device JWT itself IS signature-verified against it).
  // spec/02 § Control IPC: the host is the only party that mints the local
  // key. Generated fresh on every start and written beside the socket at
  // ~/.patch/local.key (0600), so a key from a previous run stops working the
  // moment the host it belonged to is gone.
  const localKey = mintLocalKey(config.patchHome);
  logger.info({ path: localKeyPath(config.patchHome) }, 'patch-daemon: local control key minted');

  const daemonKeyClaims = ((): { sub: string; daemon_id: string } => {
    const seg = daemonKey.split('.')[1];
    if (seg === undefined) throw new Error('daemon.key: malformed JWT (no payload segment)');
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as {
      sub?: unknown;
      daemon_id?: unknown;
    };
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('daemon.key: payload has no `sub` (account public key)');
    }
    // Every frame this host emits names the host it is about, so a host
    // that cannot state its own id must not start — an unaddressed frame would
    // be attributed to whichever host the surface guessed. NO FALLBACK.
    if (typeof payload.daemon_id !== 'string' || payload.daemon_id.length === 0) {
      throw new Error("daemon.key: payload has no `daemon_id` (this host's identity)");
    }
    return { sub: payload.sub, daemon_id: payload.daemon_id };
  })();
  /** This host's id. Stamped on every frame this host emits. */
  const selfHostId = daemonKeyClaims.daemon_id;
  // The service manager appends stdout/stderr to daemon.log for ever; cap it.
  const daemonLog = join(config.patchHome, 'logs', 'daemon.log');
  const rotateDaemonLog = (): void => {
    try {
      if (rotateLog(daemonLog)) logger.info({ path: daemonLog }, 'daemon.log rotated');
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'daemon.log rotation failed');
    }
  };
  rotateDaemonLog();
  setInterval(rotateDaemonLog, 60 * 60_000).unref();
  const codexAccounts = new CodexAccounts({
    root: join(config.patchHome, 'openai'),
    hostId: selfHostId,

    logger,
    onChange: () => {
      link.send(codexAccounts.report());
      publishHost();
    },
    // A ChatGPT sign-in run here is the account's, not this host's: it goes
    // to the server, which sends it back to every host (spec/01 § Settings).
    onSignedIn: (requestId, account) =>
      link.send({ type: 'settings.account_signed_in', hostId: selfHostId, requestId, account }),
  });
  const codexSessions = new CodexSessions(join(config.patchHome, 'openai-history'), logger);
  // spec/02 § Provider adapters — local models and routers are endpoints
  // inside Codex and Claude Code, set once for the account.
  const modelEndpoints = new ModelEndpointRegistry();
  const codexBackend = new CodexBackend(codexAccounts, codexSessions, modelEndpoints);
  // ACP agents (spec/02 § Provider adapters): which agents exist is the shared
  // `acpAgents` setting over the built-in list; this host offers those whose
  // command it has. Their credential is the agent's first ACP account, which
  // the server sends with every snapshot (spec/10 § Backend credentials), else
  // a shared provider key, else the agent's own sign-in on this host.
  let onAcpChange: () => void = () => undefined;
  // Which ACP account a turn runs on: the shared order and strategy, a chat's
  // lock, skipping an account its agent refused as limited or signed out
  // (spec/10 § Limits). What the agent said about each account is reported to
  // the server, which derives the account's state from it (decision 24), and
  // kept across a restart like Claude's.
  const acpAvailabilityPath = join(config.patchHome, 'acp-account-availability.json');
  let sendAcpReport: () => void = () => undefined;
  const acpAccounts = new AcpAccounts({
    hostId: selfHostId,
    initial: readAccountExhaustion(acpAvailabilityPath),
    onChange: (entries) => {
      try {
        writeAccountExhaustion(acpAvailabilityPath, entries);
      } catch (err) {
        logger.error(
          { err: (err as Error).message },
          'ACP account refusals could not be saved; they hold until the host restarts',
        );
      }
      sendAcpReport();
    },
  });
  /** The shared `accountStrategy.acp`, kept here as each snapshot is applied. */
  let acpStrategy: AccountStrategy = 'priority';
  const acpRoute = (preferred?: string): AcpRoute => ({
    strategy: acpStrategy,
    ...(preferred !== undefined ? { preferred } : {}),
    // A chat locked to one account runs elsewhere while it is refused only
    // when the user chose to continue on another account (spec/10 § Limits).
    resumeOnAnyAccount: limitBehaviour === 'other_account',
  });
  const acpRegistry = new AcpRegistry({
    providerKey: (id) => providerKeys.get(id),
    accountKey: (agentId, accountId) =>
      accountId !== undefined
        ? acpAccounts.get(accountId)?.apiKey
        : acpAccounts.resolve(agentId, acpRoute())?.apiKey,
    baseEnv: () => ({ ...process.env }),
    scratchDir: join(config.patchHome, 'acp-probe'),
    clientVersion: VERSION,
    onChange: () => onAcpChange(),
  });
  const acpBackend = new AcpBackend(acpRegistry, VERSION, {
    signedOut: (accountId, reason) => {
      acpAccounts.markSignedOut(accountId, reason);
      logger.warn(
        { accountId },
        'ACP account refused as signed out — skipped until it has a new key',
      );
      onAcpChange();
    },
    worked: (accountId) => acpAccounts.noteWorked(accountId),
  });
  const routedBackend: SdkBackend = {
    run: (opts) => adapterForModel(providerAdapters, opts.model).run(opts),
  };

  /**
   * Reject a host-scoped frame that names a different host. Reaching this
   * host at all means the server mis-routed it; acting on it would apply the
   * user's change to the wrong host, which is strictly worse than dropping
   * it with a warning that names both ids.
   */
  const isForThisHost = (hostId: string, frameType: string): boolean => {
    if (hostId === selfHostId) return true;
    logger.warn(
      { frameType, addressedTo: hostId, selfHostId },
      'host-scoped frame addressed to another host; dropping',
    );
    return false;
  };

  /**
   * Everything a surface can CHANGE about this host, persisted so the change
   * outlives the process (spec/02 § Host identity). A rename that reverts on
   * restart is indistinguishable from an edit that never saved.
   */
  const hostStateStore = new HostStateStore(config.patchHome, logger);
  const persistedHostState = hostStateStore.get();
  /** This host's user-editable label (`host.rename`). */
  let hostName = persistedHostState.hostName ?? config.hostName;
  /** Does the server have this host running the Manager (`host.set_manager`)? */
  let runsManager = persistedHostState.runsManager ?? false;
  /** Currently selected Kokoro TTS voice (`host.settings` → `kokoroVoice`). */
  /** Agents can call you, from the last shared-settings snapshot (spec/07 § Agent-initiated voice). */
  let agentsCanCall = true;
  let kokoroVoice: string | undefined = persistedHostState.kokoroVoice;
  /** Which engine speaks (`host.settings` → `ttsBackend`); absent is Kokoro. */
  let ttsBackend: 'kokoro' | 'elevenlabs' = persistedHostState.ttsBackend ?? 'kokoro';
  /** The ElevenLabs voice id in use (`host.settings` → `elevenLabsVoice`). */
  let elevenLabsVoice: string | undefined = persistedHostState.elevenLabsVoice;
  /** The ElevenLabs speech model (`host.settings` → `elevenLabsModel`); absent keeps the per-purpose defaults. */
  let elevenLabsModel: ElevenLabsTtsModel | undefined = persistedHostState.elevenLabsModel;
  /**
   * The voice agent setup and tones (spec/07 § The voice agent), and each
   * device's dictation engine — shared settings, not persisted: they arrive
   * with the settings on connect.
   */
  let voiceAgent: VoiceAgentSetting = DEFAULT_VOICE_AGENT;
  let voiceTones: VoiceTones = {};
  /** The ElevenLabs plan's credits as last read (after each ElevenLabs call, and when the voice list is read). */
  let elevenLabsPlan: PlanCredits | undefined;
  let deviceDictation: Record<string, DictationEngine> | undefined;
  /** The account's ElevenLabs voices, or why they could not be listed. */
  let elevenLabsVoices: ElevenLabsVoice[] | undefined;
  let elevenLabsVoicesError: string | undefined;
  /**
   * The account's voice config (shared settings → `voiceConfig`, spec/07):
   * speech to text, dictation, meetings and how voice devices answer. Not
   * persisted — it arrives with the settings on connect.
   */
  let voiceConfig: VoiceConfig = DEFAULT_VOICE_CONFIG;
  // Which provider keys this host holds. A surface configured onto a provider
  // whose key is missing does NOT stop the host — voice is one setting, and
  // every chat on this host would go down with it. Instead its sessions are
  // refused with `voice_key_missing` (audio/server.ts, the voice-note RPC),
  // Settings → Voice marks the cell not configured here (`host.host.voiceKeys`),
  // and this logs it now, on every config change and on every key change.
  // Read live from the provider-key store, so a key set or revoked in
  // Settings → Hosts → Keys shows here at once.
  const voiceKeys = (): VoiceKeys => ({
    gemini: providerKeys.has('gemini'),
    openai: providerKeys.has('openai'),
    groq: providerKeys.has('groq'),
    elevenlabs: providerKeys.has('elevenlabs'),
    deepgram: providerKeys.has('deepgram'),
    assemblyai: providerKeys.has('assemblyai'),
  });
  logVoiceKeysMissing(logger, voiceConfig, voiceAgent, voiceKeys());
  // spec/07 § The voice agent — each provider's models and voices, read with
  // this host's key for Settings → Voice calls; again on a key change and on
  // Refresh (`host.voice_catalog_refresh`). Its reads finish asynchronously,
  // so `publishHost` is defined by the time it is called.
  const voiceCatalog = new VoiceCatalogStore({
    ...(testHooks?.voiceCatalogFetch ? { fetchImpl: testHooks.voiceCatalogFetch } : {}),
    key: (provider) => providerKeys.get(provider),
    onChange: () => publishHost(),
    onError: (provider, message) =>
      logger.error({ provider, err: message }, 'voice: could not read the provider catalog'),
  });
  // spec/07 § Call cost — every costed call, and this host's totals.
  const voiceLedger = createVoiceLedger(join(config.patchHome, 'voice-usage.jsonl'));
  /**
   * How many user messages between auto-regen of the chat name.
   * 0 = disabled (title only from first message).
   */
  let chatNameInterval: number = persistedHostState.chatNameInterval ?? 0;
  /** Whether the AI title / status one-shots run (Settings → token use). On unless turned off. */
  let titleGenerationEnabled = persistedHostState.titleGenerationEnabled ?? true;
  let statusGenerationEnabled = persistedHostState.statusGenerationEnabled ?? true;
  /**
   * The Manager's bounded context window (spec/06 § Bounded context).
   * A generous built-in default so a host that hasn't yet heard the
   * account's own setting from the server doesn't truncate aggressively.
   */
  let managerContextWindow: number = persistedHostState.managerContextWindow ?? 200;
  /** spec/16 § Speaking aloud — `host.settings` → `voiceDevicePrompt`. */
  let voiceDevicePrompt: string = DEFAULT_SHARED_SETTINGS.voiceDevicePrompt;
  /** spec/06 § Manager prompt and folder — the last the server sent; absent until the first snapshot. */
  let managerPrompt: string | undefined = persistedHostState.managerPrompt;
  let managerFolder: string | undefined = persistedHostState.managerFolder;
  /** spec/07 § A call to the Manager — `host.settings` → `managerVoicePrompt`. */
  let managerVoicePrompt: string = DEFAULT_SHARED_SETTINGS.managerVoicePrompt;
  /** spec/07 § Voice instructions — `host.settings` → `voiceInstructions`. */
  let voiceInstructions: string = DEFAULT_SHARED_SETTINGS.voiceInstructions;
  /** spec/16 § Who is speaking — `host.settings` → `voiceProfiles`. */
  let voiceProfiles: SharedSettings['voiceProfiles'] = [];
  let voiceMatchThreshold: number = DEFAULT_SHARED_SETTINGS.voiceMatchThreshold;
  // Settings → Goals (spec/04 § Goals): how the goal judge is asked, and when a goal gives up on a refusing agent.
  let meetingPrompts: MeetingPrompts = {
    now: DEFAULT_MEETING_NOW_PROMPT,
    notes: DEFAULT_MEETING_NOTES_PROMPT,
    actions: DEFAULT_MEETING_ACTIONS_PROMPT,
  };
  let meetingModels = {
    analysis: DEFAULT_MEETING_MODEL,
    cleanup: DEFAULT_MEETING_MODEL,
    research: DEFAULT_MEETING_MODEL,
  };
  let meetingResearchSeconds = DEFAULT_MEETING_RESEARCH_SECONDS;
  let meetingTranscriptionModel = '';
  let goalStringency: GoalStringency = persistedHostState.goalStringency ?? DEFAULT_GOAL_STRINGENCY;
  let goalEvalPrompt: string = persistedHostState.goalEvalPrompt ?? DEFAULT_GOAL_EVAL_PROMPT;
  // Settings → Agent: the check-in a running background task sends its agent.
  let watchCheckInPrompt: string =
    persistedHostState.watchCheckInPrompt ?? DEFAULT_WATCH_CHECK_IN_PROMPT;
  let cleanupRan = false;
  let watchCheckInMinutes: number =
    persistedHostState.watchCheckInMinutes ?? DEFAULT_WATCH_CHECK_IN_MINUTES;
  let goalModel: string = persistedHostState.goalModel ?? DEFAULT_GOAL_MODEL;
  let goalRefusalLimit: number = persistedHostState.goalRefusalLimit ?? DEFAULT_GOAL_REFUSAL_LIMIT;
  /**
   * Whether this host auto-resumes turns blocked by a Claude API usage/rate
   * limit (spec/10 § Usage limits). Persisted in host.json; ON unless the user
   * has explicitly turned it off.
   *
   * It used to default off, on the reasoning that auto-resuming would surprise
   * a first-time user. In practice the surprise runs the other way: a chat
   * that hits the 5-hour limit is silently abandoned mid-task, and unattended
   * work (jobs, crons) is lost with no label, no comment and no retry. Waiting
   * for a known reset time is the unsurprising behaviour; dropping the turn is
   * not.
   */
  let autoResumeRateLimit = persistedHostState.autoResumeRateLimit ?? true;
  /**
   * What a turn does after a temporary limit (spec/10 § When an account hits a
   * limit), from the shared `limitBehaviour`. A host state written before the
   * setting reads as what its `autoResumeRateLimit` meant, until the server's
   * first snapshot says.
   */
  let limitBehaviour: LimitBehaviour =
    persistedHostState.limitBehaviour ?? limitBehaviourFromAutoResume(autoResumeRateLimit);
  // Whether the scheduled check installs a published build itself. A manual
  // `host.update` and an unreadable server greeting always apply.
  let autoUpdateHosts = persistedHostState.autoUpdateHosts ?? true;

  /**
   * Whether an unanswered question on this host expires, and the window it is
   * given (spec/02 § Questions are not approvals). Persisted in host.json; ON
   * by default, because a question nobody answers parks the whole chat and the
   * agent has no way to notice.
   */
  let questionExpiry = persistedHostState.questionExpiry ?? true;
  let questionExpirySeconds =
    persistedHostState.questionExpirySeconds ?? QUESTION_EXPIRY_SECONDS_DEFAULT;
  let questionExpiredPrompt =
    persistedHostState.questionExpiredPrompt ?? DEFAULT_QUESTION_EXPIRED_PROMPT;

  /** Per-host Claude harness config (Task 3). Persisted in host.json. */
  let harnessSystemPrompt: string | undefined = persistedHostState.harnessSystemPrompt;
  // Absent means the built-in default; an empty string means the user turned it
  // off. `effectiveToolsPrompt` collapses the two into what the SDK receives.
  let harnessToolsPrompt: string | undefined = persistedHostState.harnessToolsPrompt;
  const effectiveToolsPrompt = (): string =>
    harnessToolsPrompt === undefined ? getPatchToolsPrompt() : harnessToolsPrompt;
  let harnessSkills: string[] | 'all' | undefined = persistedHostState.harnessSkills;
  // Edits of Patch tools' descriptions. The MCP child asks the host for them
  // (`GET /internal/tool-prompts`) as it starts, so each turn's child starts
  // from the current set.
  let toolPromptOverrides: Record<string, string> = persistedHostState.toolPromptOverrides ?? {};
  const toolPromptDefaults = patchToolDescriptions();
  // The small one-shot jobs' model list (shared `smallJobModels`). Read on
  // every job, so an edit applies to the next one.
  let smallJobModels: readonly string[] =
    persistedHostState.smallJobModels ?? DEFAULT_SMALL_JOB_MODELS;
  // The three "layer" toggles (spec/14 § Agent behavior). Unlike the fields
  // above, these always resolve to a concrete boolean — there is no "SDK
  // default" reading for them to fall back to, only a stated default per
  // toggle.
  let harnessMemoryEnabled = persistedHostState.harnessMemoryEnabled ?? false;
  // The MCP servers this host adds to every chat (Settings → MCP). A host
  // that predates the list is seeded ONCE with the pair the old Browser tools
  // toggle wired, enabled as that toggle was, and the seed is persisted so the
  // list is the only authority from here on.
  let harnessMcpServers: McpServerConfig[] =
    persistedHostState.harnessMcpServers ??
    seedMcpServers(persistedHostState.harnessBrowserToolsEnabled ?? false);
  if (persistedHostState.harnessMcpServers === undefined) {
    hostStateStore.update({ harnessMcpServers });
    logger.info(
      { harnessMcpServers: harnessMcpServers.map((s) => ({ name: s.name, enabled: s.enabled })) },
      'MCP server list seeded from the Browser tools toggle',
    );
  }
  // Patch's own tools server. On unless the user switched it off (Settings → MCP).
  let patchMcpEnabled = persistedHostState.patchMcpEnabled ?? true;
  // The shipped Manager/Speakers CLAUDE.md ALWAYS loads: its toggle
  // was dropped from Settings ("pick it up automatically"). A `false` left in
  // host.json, or sent by a surface that still shows the toggle, is ignored —
  // said once in the log, so a host that "had it off" is not a mystery.
  let claudeMdOffIgnoredLogged = false;
  const ignoreClaudeMdOff = (source: 'host.json' | 'host.settings'): void => {
    if (claudeMdOffIgnoredLogged) return;
    claudeMdOffIgnoredLogged = true;
    logger.warn(
      { source },
      'harnessClaudeMdEnabled: false ignored — the shipped special-thread CLAUDE.md always loads now',
    );
  };
  if (persistedHostState.harnessClaudeMdEnabled === false) ignoreClaudeMdOff('host.json');
  // MCP Apps (SEP-1865): the servers a chat's agent sees are the ones its UI
  // may talk to — this host's enabled list, then Claude Code's own for the folder.
  const mcpApps = new McpApps({
    logger,
    serversFor: (folder) => {
      const merged = new Map<string, McpServerConfig>();
      for (const s of discoverClaudeMcpServers(folder)) merged.set(s.name, s);
      for (const s of enabledMcpServers(harnessMcpServers)) merged.set(s.name, s);
      return [...merged.values()];
    },
    folderOf: (chatId) => daemon.chatState.get(chatId)?.folder,
    connect: stdioConnector(logger),
  });
  /**
   * Rebuild the host's harness config from the current in-memory settings
   * and push it in. Called on boot and after ANY of the harness fields
   * changes, so a change to one never leaves another stale on the object the
   * SDK actually reads.
   */
  const applyHarnessConfig = (): void => {
    daemon.setHarnessConfig({
      systemPrompt: harnessSystemPrompt,
      toolsPrompt: effectiveToolsPrompt(),
      skills: harnessSkills,
      memoryEnabled: harnessMemoryEnabled,
      mcpServers: enabledMcpServers(harnessMcpServers),
      patchMcpEnabled,
    });
  };

  /**
   * Whether the server has published a build newer than the one running here
   * (spec/02 § Optional components / spec/11 § Host installation). Starts
   * false and becomes true only when a check has actually found one — a host
   * must never claim an update it has not seen.
   */
  let updateAvailable = false;
  // A newer build is published but this host's artifact is still being built.
  let updatePending = false;
  // Why the last update attempt was refused, in the words a surface shows; cleared by the next one that is not.
  let updateRefused: string | undefined;

  // See `createUpdateGate` — joins every caller (the `host.update` wire event
  // and `patch hosts update`'s local control command) onto one in-flight
  // attempt rather than letting a second click race the installer.
  const applyUpdateGated = createUpdateGate();
  // A deploy publishes this host's artifact a minute or two after the
  // version bump. Wait that out quietly; only a build that
  // is STILL missing after the window is shown to the user.
  const artifactWait = createArtifactWait({
    onPendingChange: (pending) => {
      updatePending = pending;
      emit(describeHost());
    },
    onGiveUp: (message) => {
      logger.warn({ reason: message }, 'host.update refused (artifact never appeared)');
      emit({
        type: 'chat.error',
        chatId: 'pending-spawn',
        error: {
          code: 'invalid_frame',
          message: describeUpdateRefusal(message),
        },
        seq: OUT_OF_BAND_SEQ,
      });
      emit(describeHost());
    },
  });
  // spec/02 § Self-update holds for calls — an update restarts the host, which
  // would cut a live call. Wait for calls to end (bounded), then install.
  const applyNow = async (stagedVersion?: string): ReturnType<typeof applyUpdate> => {
    await waitForCallsToEnd({
      activeCount: () => audioServer?.activeCount() ?? 0,
      logger,
    });
    return applyNowUnheld(stagedVersion);
  };
  const applyNowUnheld = (stagedVersion?: string): ReturnType<typeof applyUpdate> =>
    applyUpdateGated({
      serverUrl: config.serverUrl,
      ...(stagedVersion ? { stagedVersion } : {}),
      internalToken: config.internalToken,
      currentVersion: VERSION,
      target: BUILD_TARGET,
      patchHome: config.patchHome,
      // Recorded only once the installer is about to run, so a deferred
      // or artifact-pending apply leaves the version free to retry.
      onInstallStart: (version) => {
        hostStateStore.update({ lastAutoUpdateAttempt: version });
        try {
          logger.info(
            { version, attempt: countUpdateAttempt(config.patchHome, version) },
            'self-update: install attempt',
          );
        } catch (err) {
          logger.error({ err }, 'self-update: could not count the install attempt');
        }
      },
      logger,
    });

  // A build staged ahead of the server's restart (spec/11 § Updates in
  // lockstep). Anything left from an older run that is no longer ahead goes.
  pruneStaged(config.patchHome, VERSION);
  try {
    // The host's own work folder, plus the system temp dir where older builds left theirs.
    const sweptWork = [updateWorkRoot(config.patchHome), tmpdir()].flatMap((root) =>
      sweepUpdateWorkDirs(root, undefined, undefined, (name, err) =>
        logger.error({ err, folder: name }, 'self-update: could not sweep update folder, skipped'),
      ),
    );
    if (sweptWork.length)
      logger.info({ removed: sweptWork }, 'self-update: swept leftover update folders');
  } catch (err) {
    logger.error({ err }, 'self-update: sweeping leftover update folders failed');
  }
  let staging: Promise<void> | null = null;
  const stageAhead = (version: string): void => {
    if (!autoUpdateHosts) {
      logger.info({ version }, 'self-update: not staging (auto-update is off on this host)');
      return;
    }
    if (version === VERSION || staging) return;
    staging = stageUpdate({
      serverUrl: config.serverUrl,
      internalToken: config.internalToken,
      currentVersion: VERSION,
      target: BUILD_TARGET,
      patchHome: config.patchHome,
      version,
    })
      .then((r) =>
        logger[r.staged ? 'info' : 'error']({ version, result: r.message }, 'self-update: stage'),
      )
      .catch((err: unknown) => logger.error({ err, version }, 'self-update: stage crashed'))
      .finally(() => {
        staging = null;
      });
  };
  /**
   * The server says it is restarting into `version`. With that build staged,
   * install it now so host and server come back together; without it, do
   * nothing — the two-minute update check takes over. Holds for running
   * turns like any update.
   */
  const swapToStaged = (version: string | null): void => {
    if (!version || version === VERSION || !autoUpdateHosts) return;
    if (!stagedBuild(config.patchHome, version)) {
      logger.warn(
        { version },
        'self-update: server restarting into a build not staged here; the scheduled check (every two minutes) will update it',
      );
      return;
    }
    logger.info(
      { version },
      'self-update: server restarting into the staged build; installing it now',
    );
    void applyNow(version).then(
      (r) =>
        logger[r.applied ? 'info' : 'error'](
          { result: r.message },
          'self-update: staged swap finished',
        ),
      (err: unknown) => logger.error({ err }, 'self-update: staged swap failed'),
    );
  };
  const applyUpdateOnce = async (): ReturnType<typeof applyUpdate> => {
    const result = await applyUpdateOnceRaw();
    const refused =
      !result.applied && !result.deferred ? describeUpdateRefusal(result.message) : undefined;
    if (refused !== updateRefused) {
      updateRefused = refused;
      emit(describeHost());
    }
    return result;
  };
  const applyUpdateOnceRaw = (): ReturnType<typeof applyUpdate> =>
    requestUpdate({
      logger,
      artifactWait,
      check: () =>
        checkForUpdate({
          serverUrl: config.serverUrl,
          currentVersion: VERSION,
          target: BUILD_TARGET,
        }),
      apply: () => applyNow(),
    });

  /**
   * Whether this host's backend credential actually WORKS — not merely
   * whether a token file exists. Seeded from the boot check, then corrected by
   * a real resolve. Reporting the boot snapshot meant an expired token still
   * read as "Connected" on every surface until someone tried to send, which is
   * why nothing warned and the whole app looked fine while being unusable.
   */
  let credentialOk = oauth.error === undefined;

  /**
   * Last-reported Claude usage per STORED ACCOUNT, keyed by `accountId` then
   * by window (spec/10 § Surface in Settings — Usage — "usage is reported per
   * host per account"). Empty for an account until the SDK's first
   * `rate_limit_event` for a chat pinned to it; each window updates
   * independently since the SDK reports one window per event.
   */
  let accountUsage: AccountUsageTracker | undefined;

  /**
   * Build the full `host.account` report for the Claude backend: every
   * stored account (spec/10 § Backend credentials — multiple accounts) plus
   * the top-level `connected`/`accountEmail`/`usage` fields mirroring the
   * ACTIVE one, for a surface that predates multi-account support.
   *
   * `activeOverride` lets a connect/disconnect/add report the `connected` state
   * it just produced immediately, rather than waiting for the next periodic
   * `refreshCredentialState` pass to catch up — the same "say what is true
   * NOW" reasoning the single-account code always had. Every OTHER account's
   * `connected` is read straight off the store (credential present or not),
   * not a live SDK re-check — re-validating every stored account's token on
   * every report would mean a network refresh call per account per emission,
   * which the single active-account gate already avoids by only running on
   * a real turn / a periodic hour tick.
   *
   * The account EMAIL is never overridden: it is read out of the store on every
   * emission, for every row including the active one. It used to come from
   * `oauth.credentials`, a snapshot taken once at boot, so any report built
   * without an explicit override — the hourly credential check, the reconnect
   * greeting, an add-account, a spawn failure — reverted the displayed name to
   * the credential in use when the host STARTED. Since the server caches the
   * last report and replays it in `auth.ok`, a surface opened after that showed
   * the account the user had switched away from. Reading the store makes the
   * top-level fields and the `accounts` rows agree by construction.
   */
  /**
   * One account's usage as the wire carries it, or undefined when nothing has
   * been read yet.
   *
   * "Nothing yet" is deliberately absent rather than an empty object: a surface
   * must be able to say "not reported" instead of drawing an empty gauge that
   * reads as zero usage.
   */
  const usageFor = (
    accountId: string,
  ):
    | {
        session?: RateLimitWindow;
        week?: RateLimitWindow;
        overage?: RateLimitWindow;
        at?: number;
      }
    | undefined => {
    const entry = accountUsage?.get(accountId);
    if (!entry) return undefined;
    const { session, week, overage } = entry.reading.windows;
    if (session === undefined && week === undefined && overage === undefined) return undefined;
    const runsOut = accountUsage?.runOutAt(accountId) ?? {};
    return {
      ...(session
        ? { session: { ...session, ...(runsOut.session ? { runsOutAt: runsOut.session } : {}) } }
        : {}),
      ...(week ? { week: { ...week, ...(runsOut.week ? { runsOutAt: runsOut.week } : {}) } } : {}),
      ...(overage ? { overage } : {}),
      at: entry.reading.at,
    };
  };

  /**
   * The AWS profiles this host has, for `host.host` (spec/10 § Backend
   * credentials). A config the host cannot read is logged and reported as no
   * profiles, so the rest of the description still goes out.
   */
  const awsProfilesNow = (): import('@patch/wire').AwsProfileInfo[] => {
    try {
      return readAwsProfiles();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'could not read the AWS profiles on this host');
      return [];
    }
  };
  /** Whether each held Bedrock account's AWS profile is signed in (checked every 10 minutes). */
  const bedrockSignIn = new BedrockSignIn({
    accounts: () => readPatchStore(oauthOpts)?.accounts ?? [],
    check: (awsProfile) => checkAwsProfile(awsProfile, { profiles: awsProfilesNow }),
    onChange: () => emit(buildAccountReport()),
    logger,
  });
  if (config.sdkBackend === 'real') bedrockSignIn.start();

  const buildAccountReport = (
    activeOverride?: { connected: boolean },
    credentialError?: NonNullable<HostAccountEvent['credentialError']>,
  ): HostAccountEvent => {
    const store = readPatchStore(oauthOpts) ?? { accounts: [], activeAccountId: null };
    const activeId = store.activeAccountId ?? undefined;
    const topConnected = activeOverride?.connected ?? credentialOk;
    const activeAccount = activeId ? store.accounts.find((a) => a.id === activeId) : undefined;
    const activeUsage = activeId ? usageFor(activeId) : undefined;
    return {
      type: 'host.account',
      hostId: selfHostId,
      backendId: CLAUDE_BACKEND_ID,
      connected: topConnected,
      accountEmail: activeAccount?.credential?.email ?? null,
      ...(activeUsage && Object.keys(activeUsage).length > 0 ? { usage: activeUsage } : {}),
      accounts: store.accounts.map((a) => {
        const usage = usageFor(a.id);
        const spent = accountRotation.snapshot().find((e) => e.accountId === a.id);
        if (a.bedrock !== undefined) {
          // Never probed (a probe would be a paid call): its spend against the
          // cap is the server's, so only the profile's sign-in and a refusal
          // are this host's to report.
          const error = bedrockSignIn.error(a.id);
          return {
            id: a.id,
            label: a.label,
            connected: error === undefined,
            ...(error !== undefined ? { error } : {}),
            accountEmail: null,
            ...(spent
              ? {
                  refusal: {
                    kind: spent.kind,
                    ...(spent.until !== undefined ? { until: spent.until } : {}),
                    message: spent.reason || 'refused',
                    at: spent.at,
                  },
                }
              : {}),
          };
        }
        return {
          id: a.id,
          label: a.label,
          connected: a.id === activeId ? topConnected : a.credential !== null,
          accountEmail: a.credential?.email ?? null,
          ...(a.credential?.organizationId !== undefined
            ? { organizationId: a.credential.organizationId }
            : {}),
          ...(usage ? { usage } : {}),
          ...(spent
            ? {
                refusal: {
                  kind: spent.kind,
                  ...(spent.until !== undefined ? { until: spent.until } : {}),
                  message: spent.reason || 'refused',
                  at: spent.at,
                },
              }
            : {}),
        };
      }),
      ...(activeId !== undefined ? { activeAccountId: activeId } : {}),
      ...(credentialError ? { credentialError } : {}),
    };
  };

  /** The accounts this host holds for the backend `model` runs on, in the shared order. */
  const heldAccountsFor = (model: string | undefined): Array<{ id: string; label: string }> =>
    adapterForModel(providerAdapters, model).heldAccounts(model);

  /**
   * This host's `host.host` self-description, rebuilt from live state each
   * time so a surface never renders a stale backend or component list. Emitted
   * on connect and after anything it reports changes.
   */
  const sleepDetector = createSleepDetector();
  // Whether this host has the Claude Code its turns run (spec/02 § Agent
  // backends). A mock backend runs none, so it counts as present.
  let claudeProvision: { state: 'present' | 'installing' | 'absent' | 'failed'; error?: string } =
    config.sdkBackend === 'mock' ||
    resolveClaudeExecutable({
      home: homedir(),
      pathEnv: process.env['PATH'] ?? '',
      override: process.env['CLAUDE_CODE_PATH'],
    }) !== undefined
      ? { state: 'present' }
      : { state: 'absent' };
  const describeHost = (): import('@patch/wire').HostInfoEvent =>
    buildHostDescription({
      ...(link.lastDrop() ? { lastDisconnect: link.lastDrop() } : {}),
      awsProfiles: awsProfilesNow(),
      hostId: selfHostId,
      hostName,
      hostVersion: VERSION,
      // spec/11 § Version reporting: all THREE stamps travel, not just the
      // version — without the commit and build instant a surface cannot tell
      // two hosts on the same version number apart, which is exactly the
      // drift the version report exists to show.
      gitSha: GIT_SHA,
      builtAt: BUILT_AT,
      // Whether the server has published a NEWER build for this host's
      // os/arch. Refreshed by the periodic check below; false until the first
      // check completes, which is the honest reading of "this host knows of
      // no newer build" rather than a claim that none exists.
      updateAvailable,
      updatePending,
      updateRefused,
      permissionModeDefault: daemon.permissionModeDefault(),
      permissionOverrides: daemon.permissionOverrideCount(),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      runsManager,
      // This host can take its queued messages from the server (spec/04).
      serverQueue: true,
      // Script and gate fires get their trigger event (spec/08).
      scriptPayload: true,
      // A turn that met a limit is said on its end; the server reads the account (spec/12).
      limitFacts: true,
      // An ACP agent's own sign-in can be run here (spec/10 § Signing in).
      acpLogin: true,
      // Finished chats and Clear reach the Manager here (spec/06).
      managerFinished: true,
      managerClear: true,
      audioRelayHost: config.audio.relayHost,
      backends: [
        {
          id: CODEX_BACKEND_ID,
          label: 'OpenAI Codex',
          version: codexAccounts.runtime.version,
          state:
            codexAccounts.runtime.provision.state !== 'idle'
              ? codexAccounts.runtime.provision.state
              : !codexAccounts.runtime.version
                ? 'absent'
                : codexAccounts.report().connected
                  ? 'present'
                  : 'logged-out',
          ...(codexAccounts.runtime.provision.state === 'failed'
            ? { error: codexAccounts.runtime.provision.error }
            : {}),
        },
        claudeBackendEntry({
          executableResolved: claudeProvision.state === 'present',
          provision: claudeProvision,
          version: null,
          credentialOk,
          ...(oauth.error ? { error: oauth.error.message } : {}),
        }),
        ...acpRegistry.backendEntries(),
      ],
      components: components.describe(),
      ...(kokoroVoice !== undefined ? { kokoroVoice } : {}),
      ttsBackend,
      ...(elevenLabsVoice !== undefined ? { elevenLabsVoice } : {}),
      ...(elevenLabsModel !== undefined ? { elevenLabsModel } : {}),
      ...(elevenLabsVoices !== undefined ? { elevenLabsVoices } : {}),
      ...(elevenLabsVoicesError !== undefined ? { elevenLabsVoicesError } : {}),
      voiceKeys: voiceKeys(),
      voiceCatalog: voiceCatalog.snapshot(),
      voiceUsage: {
        ...voiceLedger.totals(Date.now()),
        ...(elevenLabsPlan !== undefined
          ? { elevenLabsPlan: { used: elevenLabsPlan.used, limit: elevenLabsPlan.limit } }
          : {}),
      },
      providerKeys: providerKeys.describe(),
      chatNameInterval,
      titleGenerationEnabled,
      statusGenerationEnabled,
      autoResumeRateLimit: autoResumeRateLimit || undefined,
      // Both stated UNCONDITIONALLY. `|| undefined` would erase a deliberate
      // `false`, and Settings reads the absence of these two as "this host
      // is too old to have the setting" rather than as "off".
      questionExpiry,
      questionExpirySeconds,
      ...(harnessSystemPrompt !== undefined ? { harnessSystemPrompt } : {}),
      ...(harnessToolsPrompt !== undefined ? { harnessToolsPrompt } : {}),
      harnessToolsPromptDefault: getPatchToolsPrompt(),
      toolPromptDefaults,
      ...(harnessSkills !== undefined ? { harnessSkills } : {}),
      harnessMemoryEnabled,
      harnessBrowserToolsEnabled: browserToolsEnabledOf(harnessMcpServers),
      harnessMcpServers,
      patchMcpEnabled,
      // Always true: kept on the report so a surface that still reads it
      // shows the (only) state rather than "unsupported".
      harnessClaudeMdEnabled: true,
    });

  /**
   * Refuse a credential frame naming a backend this host does not have
   * (spec/03 § Host events — "a credential operation naming a backend that
   * host does not have" is rejected with the offending value named).
   *
   * Returns true when the frame was refused, so the caller stops. A silent
   * drop here is the failure mode this exists to prevent: the surface's
   * Connect button would appear to work and the host would stay logged out,
   * which is indistinguishable from a credential that did not take.
   */
  const refuseUnknownBackend = (
    frameType:
      | 'host.backend_connect'
      | 'host.backend_disconnect'
      | 'host.backend_add_account'
      | 'host.backend_usage_refresh'
      | 'host.backend_reorder_accounts'
      | 'host.backend_install',
    backendId: string,
    send: (event: import('@patch/wire').WireEvent) => void,
  ): boolean => {
    const offered = describeHost().backends.map((b) => b.id);
    if (offered.includes(backendId)) return false;
    const message = `${frameType}: this host has no backend with id: ${backendId} (has: ${offered.join(', ')})`;
    logger.warn({ backendId, offered }, message);
    send({
      type: 'chat.error',
      chatId: 'pending-spawn',
      error: { code: 'backend_not_found', message },
      seq: OUT_OF_BAND_SEQ,
    });
    return true;
  };

  /**
   * This host's last-used model (spec/02 § Agent backends). ABSENT until the
   * host reads a catalogue successfully — a host that has never read one has
   * none, and a spawn there naming no model must fail saying so rather than
   * inherit a guess.
   */
  /**
   * The model this host's model-less spawns run on: the ACCOUNT's
   * `defaultModel`, mirrored down by the server over `host.settings`.
   *
   * Persisted, so a host restarting before the server's first push still has
   * it. Nothing on this host derives it — that is the whole change. It used
   * to be `lastUsedModel`, seeded from the newest entry of the first catalogue
   * read and then overwritten by every spawn that named a model, which meant
   * the host's default was the trailing edge of whatever anyone last ran.
   * One throwaway cheap-model chat moved every unattended job onto it.
   */
  let defaultModel: string | undefined = persistedHostState.defaultModel;

  /** The account's `agentDefaultModel`, mirrored down over `host.settings`. Not persisted: a delegate cannot start before the first push. */
  let agentDefaultModel: string | undefined;

  /** Take the account default the server just sent, and tell the surfaces. */
  const setDefaultModel = (model: string): void => {
    if (model === defaultModel) return;
    defaultModel = model;
    hostStateStore.update({ defaultModel: model });
    logger.info({ defaultModel: model }, 'account default model changed');
    publishHost();
  };

  /**
   * Each installed agent's own sign-in on this host, as its last probe found
   * it (spec/10 § Signing in → an ACP agent). Only for an agent that runs on
   * no API-key account here: a probe of one that does was given the key, and
   * says nothing about the agent's own login.
   */
  const noteAcpLogins = (): void => {
    for (const agent of acpRegistry.installed()) {
      const usesKeys = agent.apiKeyEnv !== undefined && acpAccounts.forAgent(agent.id).length > 0;
      const probe = acpRegistry.lastProbe(agent.id);
      if (usesKeys || !probe) continue;
      const known = acpAccounts.hostLogin(agent.id) !== undefined;
      if (!known && !probe.loginMethods?.length) continue;
      const label = `${agent.label} · signed in on ${hostName} only`;
      if (probe.state.state === 'ready' || probe.state.state === 'near_limit')
        acpAccounts.setLogin(agent.id, label, true);
      else if (probe.state.state === 'signed_out') acpAccounts.setLogin(agent.id, label, false);
    }
  };
  /** ACP sign-ins running on this host, by login id; at most one per agent. */
  const acpLogins = new Map<string, { agentId: string; login: AcpLogin }>();
  const startAcpLogin = async (
    req: AcpLoginRequestEvent,
    send: (e: WireEvent) => void,
  ): Promise<void> => {
    const update = (
      u: Omit<AcpLoginUpdateEvent, 'type' | 'hostId' | 'loginId' | 'agentId'>,
    ): void =>
      send({
        type: 'acp.login_update',
        hostId: selfHostId,
        loginId: req.loginId,
        agentId: req.agentId,
        ...u,
      });
    const agent = acpRegistry.agent(req.agentId);
    if (!agent || !acpRegistry.command(agent)) {
      update({
        status: 'failed',
        message: `${agent?.label ?? req.agentId} is not installed on ${hostName}`,
      });
      return;
    }
    if ([...acpLogins.values()].some((l) => l.agentId === agent.id)) {
      update({
        status: 'failed',
        message: `A sign-in to ${agent.label} is already running on ${hostName}`,
      });
      return;
    }
    let methods: { id: string }[];
    try {
      methods = await acpRegistry.loginMethods(agent);
    } catch (err) {
      update({ status: 'failed', message: `${agent.label}: ${(err as Error).message}` });
      return;
    }
    if (!methods.some((m) => m.id === req.methodId)) {
      update({
        status: 'failed',
        message: `${agent.label} offers no sign-in "${req.methodId}" (it offers: ${methods.map((m) => m.id).join(', ') || 'none'})`,
      });
      return;
    }
    const label = `${agent.label} · signed in on ${hostName} only`;
    const login = acpRegistry.login(agent, req.methodId, (u) => {
      update({
        status: u.status,
        ...(u.url !== undefined ? { url: u.url } : {}),
        ...(u.userCode !== undefined ? { userCode: u.userCode } : {}),
        ...(u.loopback !== undefined ? { loopback: u.loopback } : {}),
        ...(u.message !== undefined ? { message: u.message } : {}),
      });
      if (u.status === 'complete') acpAccounts.setLogin(agent.id, label, true);
    });
    acpLogins.set(req.loginId, { agentId: agent.id, login });
    logger.info({ agentId: agent.id, methodId: req.methodId }, 'ACP sign-in started on this host');
    void login.done.then((status) => {
      acpLogins.delete(req.loginId);
      logger.info({ agentId: agent.id, status }, 'ACP sign-in on this host ended');
    });
  };
  /** Re-publish this host's self-description to every surface. */
  const publishHost = (): void => {
    link.send(describeHost());
  };
  // An ACP agent's sign-in state or the configured list changed: Settings →
  // Hosts shows the fresh rows.
  onAcpChange = (): void => {
    noteAcpLogins();
    publishHost();
  };
  // A provider key an ACP agent reads changed: its next probe sees the new one.
  providerKeys.onChange(() => publishHost());
  // A provider key set or revoked from Settings: every surface's Keys block and
  // Settings → Voice's "not configured" line follow from the fresh report, and
  // the log says which configured surfaces are now without a key.
  // ElevenLabs speech out. One backend serves every place Patch speaks (see
  // `tts` below); the host also lists the account's voices for Settings, and says
  // so loudly when it cannot.
  const elevenlabs = createElevenLabs({
    apiKey: () => providerKeys.get('elevenlabs'),
    getModel: () => elevenLabsModel,
    logger: logger.child({ component: 'elevenlabs' }),
    onUsage: (usage) => {
      voiceLedger.recordSpeech(usage);
      publishHost();
    },
  });
  const refreshElevenLabsVoices = (): void => {
    if (!providerKeys.has('elevenlabs')) {
      elevenLabsVoices = undefined;
      elevenLabsVoicesError = undefined;
      elevenLabsPlan = undefined;
      publishHost();
      return;
    }
    const apiKey = providerKeys.get('elevenlabs');
    if (apiKey) {
      void fetchPlanCredits({ apiKey })
        .then((plan) => {
          elevenLabsPlan = plan;
        })
        .catch((err: Error) =>
          logger.error(
            { component: 'elevenlabs', err: err.message },
            'elevenlabs: could not read the plan credits',
          ),
        )
        .finally(publishHost);
    }
    void elevenlabs
      .listVoices()
      .then((voices) => {
        elevenLabsVoices = voices;
        elevenLabsVoicesError = undefined;
      })
      .catch((err: Error) => {
        elevenLabsVoices = undefined;
        elevenLabsVoicesError = err.message;
        logger.error(
          { component: 'elevenlabs', err: err.message },
          'elevenlabs: voice list failed',
        );
      })
      .finally(publishHost);
  };
  // The voice agent catalog's first read; again on a key change below.
  void voiceCatalog.refreshAll();
  providerKeys.onChange(() => {
    logVoiceKeysMissing(logger, voiceConfig, voiceAgent, voiceKeys());
    publishHost();
    void voiceCatalog.refreshAll();
    refreshElevenLabsVoices();
    onSpeechKeysChanged();
  });
  if (providerKeys.has('elevenlabs')) refreshElevenLabsVoices();

  /**
   * Optional components (spec/02 § Optional components) — real downloads onto
   * this host's disk, with live progress.
   */
  // Where voice's native pieces are: the voice component on an installed host
  // (throws VoiceComponentMissingError when it is not installed), the workspace
  // dependencies from a source checkout.
  const voiceDir = voiceComponentDir(config.patchHome);
  const isArtifact = bundledBuildInfo() !== undefined;
  const voiceLoc = (): ReturnType<typeof voiceLocations> => voiceLocations(voiceDir, isArtifact);
  // spec/16 § Who is speaking — voiceprints, from the `speaker` component's model
  // and the voice component's sherpa-onnx; the voices devices heard lately.
  const speakerId = new SpeakerId({
    logger: logger.child({ component: 'speaker-id' }),
    modelPath: () => speakerModelPath(join(config.patchHome, 'components')),
    sherpaEntry: () => voiceLoc().sherpaEntry,
  });
  const recentVoices = new RecentVoices();
  /** Set once the audio stack exists (step 8): re-picks the STT engine when a component settles. */
  let onComponentsSettled = (): void => {};
  // Re-picks the speech engine when a speech key is added or removed.
  let onSpeechKeysChanged = (): void => {};
  /** Set once the speech stack is up: swap the engine for the one the setting now names. */
  let onSpeechBackendChanged = (): void => {};
  const components = new ComponentManager({
    root: join(config.patchHome, 'components'),
    hostId: selfHostId,
    serverUrl: config.serverUrl,
    ...(BUILD_TARGET !== undefined ? { target: BUILD_TARGET } : {}),
    emit: (event) => link.send(event),
    logger: logger.child({ component: 'components' }),
    onSettled: () => {
      publishHost();
      onComponentsSettled();
    },
    // spec/02 § Optional components: a voice component's weights are useless
    // without the Python sidecar that reads them, and the artifact carries that
    // sidecar's source and none of its wheels. Installing the component is where
    // the runtime gets built — on demand, per host, never in the host
    // install itself.
    provisionRuntime: async (spec, onProgress) => {
      const runtime = spec.runtime;
      /* v8 ignore next -- only called for a spec that declares a runtime. */
      if (runtime === undefined) return;
      const sourceDir = bundledSidecarDir(runtime.sidecar);
      await provisionSidecarRuntime({
        sourceDir,
        venvDir: componentRuntimeDir(join(config.patchHome, 'components'), spec.id),
        run: runProcess,
        resolveUv: () =>
          resolveUv({
            candidates: uvCandidates(config.patchHome),
            installDir: join(config.patchHome, 'tools'),
            run: runProcess,
            onProgress,
          }),
        onProgress,
        ...(runtime.extraWheels ? { extraWheels: runtime.extraWheels } : {}),
      });
    },
  });

  // Whether the server link is authed (used by RemoteJobsStore to gate RPC).
  let linkOnline = false;
  /**
   * Which OTHER hosts are linked right now. The server pushes presence to
   * every host, because a cross-chat call naming a host that is down has
   * to fail INSIDE the turn rather than buffer (spec/03 § Cross-chat tools).
   */
  const onlineHosts = new Set<string>();
  /**
   * In-flight `patch.list_chats.request` calls, keyed by the chat that asked.
   * The server owns the account-wide chat list: only it sees every host's
   * chats, and each entry it returns names the host that chat lives on.
   */
  type AccountChat = { chatId: string; hostId: string } & Record<string, unknown>;
  const listChatsWaiters = new Map<string, Array<(chats: AccountChat[]) => void>>();
  const resolveListChats = (event: { sourceChatId: string; chats: AccountChat[] }): void => {
    const waiters = listChatsWaiters.get(event.sourceChatId);
    if (!waiters || waiters.length === 0) return;
    const next = waiters.shift();
    if (waiters.length === 0) listChatsWaiters.delete(event.sourceChatId);
    next?.(event.chats);
  };
  const LIST_CHATS_TIMEOUT_MS = 10_000;
  /**
   * Ask the server for every chat on the account with the host each lives
   * on. NO FALLBACK to this host's own chats: a list that silently omits the
   * other hosts' chats is worse than an error saying the link is down.
   */
  const requestAccountChats = async (
    sourceChatId: string,
    archived?: 'only' | 'include',
  ): Promise<AccountChat[]> => {
    if (!linkOnline) {
      throw new Error('patch_list_chats: the server link is offline; cannot list other hosts');
    }
    return await new Promise((resolve, reject) => {
      const waiters = listChatsWaiters.get(sourceChatId) ?? [];
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onResolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(
          new Error(
            `listing chats: the server did not answer within ${LIST_CHATS_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, LIST_CHATS_TIMEOUT_MS);
      timer.unref();
      function onResolve(chats: AccountChat[]): void {
        clearTimeout(timer);
        resolve(chats);
      }
      waiters.push(onResolve);
      listChatsWaiters.set(sourceChatId, waiters);
      link.send({
        type: 'patch.list_chats.request',
        sourceChatId,
        ...(archived !== undefined ? { archived } : {}),
      });
    });
  };
  /** Voice timers: the server keeps the state; each ask is matched to its answer by requestId. */
  const timerWaiters = new Map<string, (event: VoiceTimersResponseEvent) => void>();
  const TIMER_TIMEOUT_MS = 15_000;
  const requestTimers = async (req: ManagerTimerRequest): Promise<string> => {
    if (!linkOnline) {
      throw new Error('Timers are kept by the server, and the link to it is offline.');
    }
    const requestId = `timers-${randomUUID()}`;
    const answer = await new Promise<VoiceTimersResponseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        timerWaiters.delete(requestId);
        reject(new Error('The server did not answer the timer request within 15 seconds.'));
      }, TIMER_TIMEOUT_MS);
      timer.unref();
      timerWaiters.set(requestId, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
      link.send({ type: 'voice.timers.request', requestId, ...req });
    });
    // A refusal ("no timer matches pasta") is an answer for the voice to say, not a host failure.
    if (!answer.ok) throw new ChatLookupError(answer.message);
    return answer.message;
  };
  /** `patch_search_chats`: one account-wide ask of the server, same waiter shape as the listing. */
  const searchWaiters = new Map<string, Array<(event: PatchSearchChatsResponseEvent) => void>>();
  const SEARCH_TIMEOUT_MS = 30_000;
  const requestSearch = async (
    sourceChatId: string,
    query: string,
    limit?: number,
  ): Promise<PatchSearchChatsResponseEvent> => {
    if (!linkOnline) {
      throw new Error('patch_search_chats: the server link is offline; cannot search chats');
    }
    return await new Promise((resolve, reject) => {
      const waiters = searchWaiters.get(sourceChatId) ?? [];
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onResolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('patch_search_chats: the server did not answer within 30s'));
      }, SEARCH_TIMEOUT_MS);
      timer.unref();
      function onResolve(event: PatchSearchChatsResponseEvent): void {
        clearTimeout(timer);
        resolve(event);
      }
      waiters.push(onResolve);
      searchWaiters.set(sourceChatId, waiters);
      link.send({
        type: 'patch.search_chats.request',
        sourceChatId,
        query,
        ...(limit !== undefined ? { limit } : {}),
      });
    });
  };
  /**
   * `patch_activity` (spec/06 § Cross-chat toolset): the user's own messages
   * are read through every host's chat logs, which only the server can
   * gather, so this is a plain account-wide ask — same waiter-map shape as `requestAccountChats`, no
   * per-chat host resolution needed.
   */
  const activityWaiters = new Map<string, Array<(event: PatchActivityResponseEvent) => void>>();
  const resolveActivity = (event: PatchActivityResponseEvent): void => {
    const waiters = activityWaiters.get(event.sourceChatId);
    if (!waiters || waiters.length === 0) return;
    const next = waiters.shift();
    if (waiters.length === 0) activityWaiters.delete(event.sourceChatId);
    next?.(event);
  };
  // Must outlast the server's own per-host retries (ACTIVITY_READ_ATTEMPTS x timeout).
  const ACTIVITY_TIMEOUT_MS = 45_000;
  const requestActivity = async (
    sourceChatId: string,
    since: number,
    until: number,
    messagesCursor?: number,
    limit?: number,
    includeSessions?: boolean,
    sessionsCursor?: number,
  ): Promise<PatchActivityResponseEvent> => {
    if (!linkOnline) {
      throw new Error('patch_activity: the server link is offline; cannot read activity');
    }
    return await new Promise((resolve, reject) => {
      const waiters = activityWaiters.get(sourceChatId) ?? [];
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onResolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('patch_activity: the server did not answer within 45s'));
      }, ACTIVITY_TIMEOUT_MS);
      timer.unref();
      function onResolve(event: PatchActivityResponseEvent): void {
        clearTimeout(timer);
        resolve(event);
      }
      waiters.push(onResolve);
      activityWaiters.set(sourceChatId, waiters);
      link.send({
        type: 'patch.activity.request',
        sourceChatId,
        since,
        until,
        ...(messagesCursor !== undefined ? { messagesCursor } : {}),
        ...(includeSessions ? { includeSessions } : {}),
        ...(sessionsCursor !== undefined ? { sessionsCursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    });
  };
  /**
   * Cross-host `patch_spawn`: emits the request and waits for the NAMED
   * host's own `patch.spawn.response` (see remote-spawn.ts for why a
   * fire-and-forget spawn was a silent-failure hole).
   */
  const remoteSpawns = createRemoteSpawnCoordinator({
    emit: (event) => emit(event),
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.spawn.response for an unknown request; dropping'),
  });
  const spawnOnRemoteHost = (req: RemoteSpawnRequest): Promise<{ chatId?: string }> =>
    remoteSpawns.spawn(req);

  /**
   * `patch_peek` / `patch_history` (spec/03 § Cross-chat tools): the server
   * answers both from its own record, for a chat on any host. `patch_send_to`
   * / `patch_stop` to a chat on another host are relayed to its owner. One
   * coordinator per tool, each minting ids under its own prefix.
   */
  const serverPeeks = createRemoteRelayCoordinator<{
    chat_state: unknown;
    events: unknown[];
    truncated: boolean;
  }>({
    emit: (event) => emit(event),
    idPrefix: 'rpeek',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.peek.response for an unknown request; dropping'),
  });
  const serverHistories = createRemoteRelayCoordinator<{
    events: WireEvent[];
    nextFromSeq?: number;
  }>({
    emit: (event) => emit(event),
    idPrefix: 'rhist',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.history.response for an unknown request; dropping'),
  });
  const remoteSendTos = createRemoteRelayCoordinator<undefined>({
    emit: (event) => emit(event),
    idPrefix: 'rsend',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.send_to.response for an unknown request; dropping'),
  });
  // The reply to a delivered message, read by the server from its record of
  // the chat. It comes when the chat has answered, however long that takes;
  // a dropped link fails every wait (the server forgets them then too).
  const serverReplies = createRemoteRelayCoordinator<{ text: string }>({
    emit: (event) => emit(event),
    idPrefix: 'rreply',
    timeoutMs: null,
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.reply.response for an unknown request; dropping'),
  });
  const replyFromServer = (req: {
    sourceChatId: string;
    targetChatId: string;
    localId: string;
  }): Promise<string> => {
    assertServerReads('the reply');
    return serverReplies
      .call(
        (requestId) => ({ type: 'patch.reply.request', requestId, ...req }),
        () => 'the reply never came',
      )
      .then((result) => result.text);
  };
  const remoteStops = createRemoteRelayCoordinator<undefined>({
    emit: (event) => emit(event),
    idPrefix: 'rstop',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.stop.response for an unknown request; dropping'),
  });
  const webBotAuthSignatures = createRemoteRelayCoordinator<{
    headers: Record<string, string>;
  }>({
    emit: (event) => emit(event),
    idPrefix: 'wba',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'web_bot_auth.sign_response for an unknown request; dropping'),
  });
  const webBotAuth = webBotAuthFromServer(config.serverUrl, (url, directoryUrl) =>
    webBotAuthSignatures
      .call(
        (requestId) => ({
          type: 'web_bot_auth.sign_request',
          hostId: selfHostId,
          requestId,
          authority: new URL(url).host,
          directoryUrl,
        }),
        () => `the Patch server did not sign ${new URL(url).host} in time`,
      )
      .then((result) => result.headers),
  );

  // spec/07 § Voice is a per-host capability, spec/03 § Audio relay over the
  // host link: this host's half of the cross-host audio relay, bridging a
  // session the server has tunnelled over THIS link to this host's own local
  // audio WSS — loopback, always reachable, regardless of what `audio.host`
  // is bound to for a surface dialling in directly.
  const audioRelayBridge = new AudioRelayBridge({
    logger: logger.child({ component: 'audio-relay-bridge' }),
    localAudioUrl: `ws://127.0.0.1:${config.audio.port}`,
    sender: (event) => emit(event),
  });
  /**
   * Refuse a read the server cannot answer right now, at once and in words,
   * rather than buffering the request until the call times out.
   */
  const assertServerReads = (tool: string): void => {
    if (!linkOnline) {
      throw new RemoteRelayError(
        'host_not_registered',
        `${tool}: the link to the Patch server is down; chats are read from the server`,
      );
    }
    if (!link.answersReads()) {
      throw new RemoteRelayError(
        'sdk_error',
        `${tool}: the Patch server is too old to answer this; update the server`,
      );
    }
  };
  const peekFromServer = async (req: {
    sourceChatId: string;
    targetChatId: string;
    limit?: number;
  }): Promise<{ chat_state: unknown; events: unknown[]; truncated: boolean }> => {
    assertServerReads('patch_peek');
    return await serverPeeks.call(
      (requestId) => ({
        type: 'patch.peek.request',
        sourceChatId: req.sourceChatId,
        targetChatId: req.targetChatId,
        requestId,
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
      }),
      () => `patch_peek: the Patch server did not answer in time`,
    );
  };
  const historyFromServer = async (req: {
    sourceChatId: string;
    targetChatId: string;
    fromSeq?: number;
    limit?: number;
  }): Promise<{ events: WireEvent[]; nextFromSeq?: number }> => {
    assertServerReads('patch_history');
    return await serverHistories.call(
      (requestId) => ({
        type: 'patch.history.request',
        sourceChatId: req.sourceChatId,
        targetChatId: req.targetChatId,
        requestId,
        ...(req.fromSeq !== undefined ? { fromSeq: req.fromSeq } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
      }),
      () => `patch_history: the Patch server did not answer in time`,
    );
  };
  const sendToRemoteChat = (req: {
    sourceChatId: string;
    targetChatId: string;
    message: string;
    localId: string;
    voicePrefix?: string;
    revealTarget: boolean;
  }): Promise<void> =>
    remoteSendTos
      .call(
        (requestId) => ({
          type: 'patch.send_to',
          sourceChatId: req.sourceChatId,
          targetChatId: req.targetChatId,
          message: req.message,
          localId: req.localId,
          requestId,
          revealTarget: req.revealTarget,
          ...(req.voicePrefix !== undefined ? { voicePrefix: req.voicePrefix } : {}),
        }),
        () => `patch_send_to: chat ${req.targetChatId}'s host did not answer in time`,
      )
      .then(() => undefined);

  const stopRemoteChat = (req: { sourceChatId: string; targetChatId: string }): Promise<void> =>
    remoteStops
      .call(
        (requestId) => ({
          type: 'patch.stop',
          sourceChatId: req.sourceChatId,
          targetChatId: req.targetChatId,
          requestId,
        }),
        () => `patch_stop: chat ${req.targetChatId}'s host did not answer in time`,
      )
      .then(() => undefined);

  // Forward-declared so the onFrame closure (constructed below, before the
  // audio server boots) can route `chat.focus_change` into the surface's open
  // voice session for focus-follow (spec/07 ## Focus-follow). Assigned once the
  // audio WSS is up at step 8.
  let audioServer: AudioServerHandle | undefined;
  // Forward-declared so the onFrame closure (constructed below, before the
  // whisper backend is built at step 8) can service the server's
  // `patch.voice_note.transcribe_request` RPC (spec/07 § End-to-end voice
  // transport — the mobile voice-note upload path). Assigned once the whisper
  // backend is created at step 8.
  let whisper: WhisperBackend | undefined;
  let liveRecognizer: ParakeetLiveRecognizer | undefined;
  // The dictation surface's transcribers, one per backend this host has a key
  // for (hosted-stt.ts). Assigned alongside `whisper` at step 8; the
  // transcribe RPC below picks from them by `voiceConfig.dictation.backend`.
  let dictationTranscribers: DictationTranscribers | undefined;
  // Smart Turn loads on the first turn check, not at boot: most hosts never
  // see dictation mode. A failed load is not remembered, so the next check
  // tries again and reports its own error.
  let turnDetector: Promise<TurnDetector> | null = null;
  const loadTurnDetector = (): Promise<TurnDetector> => {
    let loc: ReturnType<typeof voiceLocations>;
    try {
      loc = voiceLoc();
    } catch (err) {
      return Promise.reject(new TurnModelUnavailableError((err as Error).message));
    }
    const path = config.audio.turnModelPath ?? loc.turnModel;
    if (path === undefined) {
      return Promise.reject(
        new TurnModelUnavailableError(
          'this host has no Smart Turn model (smart_turn.onnx); set TURN_MODEL_PATH',
        ),
      );
    }
    turnDetector ??= createSmartTurnDetector(path, loc.nativeDir).catch((err: Error) => {
      turnDetector = null;
      throw new TurnModelUnavailableError(err.message);
    });
    return turnDetector;
  };
  // Meeting mode (meeting.ts). Built once the Host exists; the link handler and
  // the preprocessInput hook below only run after full wiring.
  let meetings: MeetingManager | undefined;
  // Host-owned folder registry (spec/04 § Folders). Assigned once the host
  // graph is built (below); referenced by the onAuthed / emit closures, which
  // only run after full wiring. Publishes `folders.list` on connect and
  // `folders.updated` on change.
  let folderRegistry: FolderRegistry;
  // Host-owned secret store (spec/15 § Secrets). The host owns the store
  // (it injects secrets into chats); it publishes `secrets.list` on connect and
  // `secrets.updated` after every mutation so every surface's editor reflects
  // the current set. Loaded eagerly from `<patchHome>/secrets.json`.
  const secretsStore: SecretsStore = createSecretsStore(config.patchHome);
  // Terminal sessions (spec/02 § Terminal sessions). Shells on the host,
  // driven from a surface's terminal drawer — the route by which a folder that
  // isn't on the host yet (a repo to clone) gets there. Its `emit` is bound to
  // the live link sender inside the onFrame handler, which is the only place a
  // sender is in scope; sessions are only ever created from a surface frame, so
  // there is nothing to emit before then.
  let terminalSend: ((event: WireEvent) => void) | undefined;
  const terminals = new TerminalSessions({
    // spec/02 § Host restarts: each PTY session's runner and scrollback.
    runDir: join(config.patchHome, 'terminals'),
    // A session opened with no folder (the new-chat drawer) starts in the first
    // published project root that actually exists — where a clone is going. The
    // container's $HOME is /root while the project dirs are mounted elsewhere,
    // so homing there would land the user somewhere they'd only have to cd out
    // of. `ready.cwd` still reports whatever it resolved to.
    defaultCwd: () =>
      folderRegistry.list().find((f) => {
        try {
          return statSync(f).isDirectory();
        } catch {
          return false;
        }
      }),
    emit: (event) => {
      // Before any surface frame arrives (a session reattached at start) the
      // link's own sender stands in; it buffers while the server is away.
      (terminalSend ?? ((e: WireEvent) => link.send(e)))(event);
    },
    logger,
  });
  // Script job runs (spec/08 § Action — `script`). Each runs detached and is
  // persisted, so a host restart mid-run picks it up and still reports it
  // (spec/02 § Host restarts). Results go through the link, which buffers
  // them while the server is away.
  const jobRuns = new JobRuns({
    runDir: join(config.patchHome, 'job-runs'),
    emit: (event) => link.send(event),
    logger: logger.child({ component: 'job-runs' }),
  });
  // Host search (spec/02 § Host search). Same bound-sender pattern as
  // `terminals` above — a session only exists downstream of a surface frame,
  // so the sender is always bound by the time anything needs to emit.
  let hostSearchSend: ((event: WireEvent) => void) | undefined;
  const hostSearch = new HostSearchManager({
    emit: (event) => {
      /* v8 ignore next */
      if (!hostSearchSend) return;
      hostSearchSend(event);
    },
    logger,
  });
  // The outbound server link owns its own offline buffer (cap 10k, drop-oldest;
  // spec/12). `emit` always routes through it — buffered while offline, sent
  // live once authed.
  /**
   * Run on the shared settings (spec/01 § Settings): every setting the snapshot
   * carries replaces this host's, so the host does what Settings says rather
   * than what it was last told locally.
   */
  /**
   * How each backend picks the account a turn starts on (spec/10 § Backend
   * credentials — account strategy). Priority until the first snapshot says.
   */
  let accountStrategy: SharedSettings['accountStrategy'] = DEFAULT_SHARED_SETTINGS.accountStrategy;
  /** The Claude account titles and status summaries run on, or `auto` (spec/10 § Choosing an account). */
  let backgroundAccount: SharedSettings['backgroundAccount'] =
    DEFAULT_SHARED_SETTINGS.backgroundAccount;
  let webBotAuthEnabled = false;

  // The account's Manager and Speakers model (Settings → Manager). Undefined
  // until the server's first settings push; applied again whenever it changes
  // and once the threads exist, so neither order loses it.
  let specialThreadModel: string | undefined;
  const applySpecialThreadModel = (): void => {
    if (specialThreadModel === undefined || !runsManager) return;
    const model = specialThreadModel;
    daemon.applySpecialThreadModel(model).then(
      () => logger.info({ model }, 'special thread model applied'),
      (err: unknown) =>
        logger.warn({ model, err: (err as Error).message }, 'special thread model refused'),
    );
  };
  /** The endpoints and their keys, as the last settings snapshot gave them. */
  let endpointSettings: SharedSettings['modelEndpoints'];
  let endpointKeys: Record<string, string> | undefined;
  const applySharedHostSettings = (shared: SharedSettings): void => {
    if (shared.agentIdentity.enabled !== webBotAuthEnabled) {
      webBotAuthEnabled = shared.agentIdentity.enabled;
      daemon.setWebBotAuth(webBotAuthEnabled ? webBotAuth : undefined);
      logger.info({ enabled: webBotAuthEnabled }, 'Web Bot Auth browser signing changed');
    }
    if (shared.permissionModeDefault !== daemon.permissionModeDefault()) {
      daemon.setPermissionModeDefault(shared.permissionModeDefault);
      hostStateStore.update({ permissionModeDefault: shared.permissionModeDefault });
      logger.info(
        { permissionModeDefault: shared.permissionModeDefault },
        'default permission mode changed',
      );
    }
    daemon.setProviderPermissionDefaults(shared.providerPermissionDefaults);
    endpointSettings = shared.modelEndpoints;
    modelEndpoints.apply(endpointSettings, endpointKeys);
    acpRegistry.setConfigured(shared.acpAgents);
    setDefaultModel(shared.defaultModel);
    agentDefaultModel = shared.agentDefaultModel;
    if (shared.specialThreadModel !== specialThreadModel) {
      specialThreadModel = shared.specialThreadModel;
      applySpecialThreadModel();
    }
    agentsCanCall = shared.agentsCanCall;
    if (JSON.stringify(shared.voiceConfig) !== JSON.stringify(voiceConfig)) {
      voiceConfig = shared.voiceConfig;
      logger.info({ voiceConfig }, 'voice config changed');
      logVoiceKeysMissing(logger, voiceConfig, voiceAgent, voiceKeys());
    }
    if (shared.kokoroVoice !== undefined && shared.kokoroVoice !== kokoroVoice) {
      kokoroVoice = shared.kokoroVoice;
      hostStateStore.update({ kokoroVoice });
      logger.info({ kokoroVoice }, 'kokoro voice changed');
    }
    if (shared.ttsBackend !== undefined && shared.ttsBackend !== ttsBackend) {
      ttsBackend = shared.ttsBackend;
      hostStateStore.update({ ttsBackend });
      logger.info({ ttsBackend }, 'speech engine changed');
      if (ttsBackend === 'elevenlabs') refreshElevenLabsVoices();
    }
    if (shared.elevenLabsVoice !== undefined && shared.elevenLabsVoice !== elevenLabsVoice) {
      elevenLabsVoice = shared.elevenLabsVoice;
      hostStateStore.update({ elevenLabsVoice });
      logger.info({ elevenLabsVoice }, 'elevenlabs voice changed');
    }
    if (shared.elevenLabsModel !== undefined && shared.elevenLabsModel !== elevenLabsModel) {
      elevenLabsModel = shared.elevenLabsModel;
      hostStateStore.update({ elevenLabsModel });
      logger.info({ elevenLabsModel }, 'elevenlabs model changed');
    }
    if (JSON.stringify(shared.voiceAgent) !== JSON.stringify(voiceAgent)) {
      voiceAgent = shared.voiceAgent;
      logger.info({ voiceAgent }, 'voice agent setup changed');
      logVoiceKeysMissing(logger, voiceConfig, voiceAgent, voiceKeys());
    }
    voiceTones = shared.voiceTones;
    if (JSON.stringify(shared.deviceDictation) !== JSON.stringify(deviceDictation)) {
      deviceDictation = shared.deviceDictation;
      logger.info({ deviceDictation }, 'per-device dictation engines changed');
    }
    if (shared.voiceDevicePrompt !== voiceDevicePrompt) {
      voiceDevicePrompt = shared.voiceDevicePrompt;
      logger.info('voice device prompt changed');
    }
    if (shared.managerVoicePrompt !== managerVoicePrompt) {
      managerVoicePrompt = shared.managerVoicePrompt;
      logger.info('manager voice prompt changed');
    }
    if (shared.voiceInstructions !== voiceInstructions) {
      voiceInstructions = shared.voiceInstructions;
      logger.info('voice instructions changed');
    }
    if (JSON.stringify(shared.voiceProfiles) !== JSON.stringify(voiceProfiles)) {
      voiceProfiles = shared.voiceProfiles;
      logger.info(
        {
          profiles: voiceProfiles.map((p) => ({
            name: p.name,
            access: p.access,
            samples: p.samples,
          })),
        },
        'voice profiles changed',
      );
    }
    if (shared.voiceMatchThreshold !== voiceMatchThreshold) {
      voiceMatchThreshold = shared.voiceMatchThreshold;
      logger.info({ voiceMatchThreshold }, 'voice match threshold changed');
    }
    if (shared.managerPrompt !== managerPrompt || shared.managerFolder !== managerFolder) {
      managerPrompt = shared.managerPrompt;
      managerFolder = shared.managerFolder;
      hostStateStore.update({ managerPrompt, managerFolder });
      applyManagerSettings();
      logger.info({ managerFolder }, 'manager prompt or folder changed');
    }
    if (shared.managerContextWindow !== managerContextWindow) {
      managerContextWindow = shared.managerContextWindow;
      daemon.setManagerContextWindow(managerContextWindow);
      hostStateStore.update({ managerContextWindow });
      logger.info({ managerContextWindow }, 'manager context window changed');
    }
    if (
      shared.goalEvalPrompt !== goalEvalPrompt ||
      shared.goalModel !== goalModel ||
      shared.goalRefusalLimit !== goalRefusalLimit ||
      shared.goalStringency !== goalStringency
    ) {
      goalEvalPrompt = shared.goalEvalPrompt;
      goalModel = shared.goalModel;
      goalRefusalLimit = shared.goalRefusalLimit;
      goalStringency = shared.goalStringency;
      daemon.setGoalRefusalLimit(goalRefusalLimit);
      hostStateStore.update({ goalEvalPrompt, goalModel, goalRefusalLimit, goalStringency });
      logger.info({ goalModel, goalRefusalLimit, goalStringency }, 'goal settings changed');
    }
    meetingPrompts = {
      now: shared.meetingNowPrompt,
      notes: shared.meetingNotesPrompt,
      actions: shared.meetingActionsPrompt,
    };
    meetingModels = {
      analysis: shared.meetingAnalysisModel,
      cleanup: shared.meetingCleanupModel,
      research: shared.meetingResearchModel,
    };
    meetingResearchSeconds = shared.meetingResearchSeconds;
    if (shared.meetingTranscriptionModel !== meetingTranscriptionModel) {
      meetingTranscriptionModel = shared.meetingTranscriptionModel;
      whisper?.useModel?.(meetingTranscriptionModel);
      logger.info({ meetingTranscriptionModel }, 'meeting transcription model changed');
    }
    if (
      shared.watchCheckInPrompt !== watchCheckInPrompt ||
      shared.watchCheckInMinutes !== watchCheckInMinutes
    ) {
      watchCheckInPrompt = shared.watchCheckInPrompt;
      watchCheckInMinutes = shared.watchCheckInMinutes;
      daemon.setWatchCheckIn({
        intervalMs: watchCheckInMinutes * 60_000,
        prompt: watchCheckInPrompt,
      });
      hostStateStore.update({ watchCheckInPrompt, watchCheckInMinutes });
      logger.info({ watchCheckInMinutes }, 'watch check-in settings changed');
    }
    if (!cleanupRan) {
      // Once per host start, on the first settings snapshot (carries the period).
      cleanupRan = true;
      if (shared.cleanupPeriodDays === 0) {
        logger.info('startup cleanup off: cleanupPeriodDays is 0 (never)');
        return;
      }
      if (!Number.isInteger(shared.cleanupPeriodDays) || shared.cleanupPeriodDays < 1) {
        logger.error(
          { period: shared.cleanupPeriodDays },
          'startup cleanup skipped: server sent no valid cleanupPeriodDays',
        );
        return;
      }
      void daemon
        .cleanupOldData(cutoffMs(Date.now(), shared.cleanupPeriodDays))
        .then((r) =>
          logger.info(
            {
              chats: r.chats.length,
              worktrees: r.worktrees.removed.length,
              kept: r.worktrees.kept.length,
            },
            'startup cleanup done',
          ),
        )
        .catch((err) => logger.error({ err }, 'startup cleanup failed'));
    }
    if (shared.chatNameInterval !== chatNameInterval) {
      chatNameInterval = shared.chatNameInterval;
      hostStateStore.update({ chatNameInterval });
    }
    if (shared.titleGenerationEnabled !== titleGenerationEnabled) {
      titleGenerationEnabled = shared.titleGenerationEnabled;
      daemon.setTitleGenerationEnabled(titleGenerationEnabled);
      hostStateStore.update({ titleGenerationEnabled });
    }
    if (shared.statusGenerationEnabled !== statusGenerationEnabled) {
      statusGenerationEnabled = shared.statusGenerationEnabled;
      daemon.setStatusGenerationEnabled(statusGenerationEnabled);
      hostStateStore.update({ statusGenerationEnabled });
    }
    if (shared.autoResumeRateLimit !== autoResumeRateLimit) {
      autoResumeRateLimit = shared.autoResumeRateLimit;
      hostStateStore.update({ autoResumeRateLimit });
    }
    if (shared.limitBehaviour !== limitBehaviour) {
      limitBehaviour = shared.limitBehaviour;
      daemon.setLimitBehaviour(limitBehaviour);
      hostStateStore.update({ limitBehaviour });
      logger.info({ limitBehaviour }, 'limit behaviour changed');
    }
    if (shared.autoUpdateHosts !== autoUpdateHosts) {
      autoUpdateHosts = shared.autoUpdateHosts;
      hostStateStore.update({ autoUpdateHosts });
    }
    if (
      shared.questionExpiry !== questionExpiry ||
      shared.questionExpirySeconds !== questionExpirySeconds ||
      shared.questionExpiredPrompt !== questionExpiredPrompt
    ) {
      questionExpiry = shared.questionExpiry;
      questionExpirySeconds = shared.questionExpirySeconds;
      questionExpiredPrompt = shared.questionExpiredPrompt;
      daemon.setQuestionExpiry({
        enabled: questionExpiry,
        seconds: questionExpirySeconds,
        expiredPrompt: questionExpiredPrompt,
      });
      hostStateStore.update({ questionExpiry, questionExpirySeconds, questionExpiredPrompt });
    }
    const systemPrompt = shared.harnessSystemPrompt || undefined;
    const toolsPrompt = toolsPromptOverride(shared.harnessToolsPrompt);
    const skills = shared.harnessSkills ?? undefined;
    if (
      systemPrompt !== harnessSystemPrompt ||
      toolsPrompt !== harnessToolsPrompt ||
      JSON.stringify(skills) !== JSON.stringify(harnessSkills) ||
      shared.harnessMemoryEnabled !== harnessMemoryEnabled
    ) {
      harnessSystemPrompt = systemPrompt;
      harnessToolsPrompt = toolsPrompt;
      harnessSkills = skills;
      harnessMemoryEnabled = shared.harnessMemoryEnabled;
      hostStateStore.update({
        harnessSystemPrompt,
        harnessToolsPrompt,
        harnessSkills,
        harnessMemoryEnabled,
      });
      applyHarnessConfig();
      logger.info('agent behaviour layers changed');
    }
    if (JSON.stringify(shared.toolPromptOverrides) !== JSON.stringify(toolPromptOverrides)) {
      toolPromptOverrides = shared.toolPromptOverrides;
      hostStateStore.update({ toolPromptOverrides });
      logger.info('tool prompt overrides changed');
    }
    if (JSON.stringify(shared.smallJobModels) !== JSON.stringify(smallJobModels)) {
      smallJobModels = shared.smallJobModels;
      hostStateStore.update({ smallJobModels: [...smallJobModels] });
      logger.info({ smallJobModels }, 'small-job models changed');
    }
    // A host whose own state says `mock` is a test fixture: no setting moves it.
    if (hostStateStore.get().speechBackend !== 'mock') {
      const speech: HostSpeechBackend | undefined =
        shared.speechBackend === 'auto' ? undefined : shared.speechBackend;
      if (speech !== hostStateStore.get().speechBackend) {
        // Refuse a named engine whose credential is missing, saying which (NO FALLBACK).
        validateWhisperCredentials({
          ...config.audio,
          whisperBackend: speech ?? 'off',
          groqApiKey: providerKeys.get('groq'),
          elevenlabsApiKey: providerKeys.get('elevenlabs'),
        });
        hostStateStore.update({ speechBackend: speech });
        config.audio.whisperBackend = speech ?? 'off';
        config.audio.speechAuto = speech === undefined;
        providerKeys.setRequiredToStart(speechRequiredKeys(config.audio.whisperBackend));
        logger.info({ speechBackend: shared.speechBackend }, 'speech engine setting changed');
        onSpeechBackendChanged();
      }
    }
    accountStrategy = shared.accountStrategy;
    backgroundAccount = shared.backgroundAccount;
    acpStrategy = shared.accountStrategy.acp ?? 'priority';
  };

  /**
   * A Bedrock account at its monthly cap is limited until the first of next
   * month, UTC (spec/10 § Spending caps); one whose cap was raised above its
   * spend is ready at once. Read from the spend the server keeps, on every
   * snapshot.
   */
  /** Bedrock accounts this host has recorded as at their cap. */
  const capMarked = new Set<string>();
  /**
   * Is this Bedrock account at its cap, counting what this host has spent on it
   * that the server has not acknowledged (`pendingBedrockSpendUsd`)?
   */
  const bedrockAtCap = (
    a: { id: string; bedrock?: SharedSecrets['claude'][number]['bedrock'] },
    now: number,
  ): boolean =>
    a.bedrock !== undefined &&
    bedrockCappedWith(
      a.bedrock,
      pendingBedrockSpendUsd(hostOutbox.pending(), a.id, now, a.bedrock.spendIds),
      now,
    );
  const syncBedrockCaps = (accounts: readonly SharedSecrets['claude'][number][]): void => {
    const now = Date.now();
    let changed = false;
    let lifted = false;
    for (const a of accounts) {
      if (a.bedrock === undefined) continue;
      const capped = bedrockAtCap(a, now);
      // A refused turn re-records the account with its own words, which name
      // the cap; a record from before a restart is found by those words too.
      const marked =
        capMarked.has(a.id) ||
        (accountRotation
          .snapshot()
          .find((e) => e.accountId === a.id)
          ?.reason.includes(BEDROCK_CAP_REACHED) ??
          false);
      if (capped) capMarked.add(a.id);
      else capMarked.delete(a.id);
      if (capped && !marked) {
        accountRotation.markExhausted(
          a.id,
          BEDROCK_CAP_REACHED,
          bedrockCapResetsAt(now),
          undefined,
          'limit',
        );
        changed = true;
      } else if (!capped && marked) {
        accountRotation.clear(a.id);
        changed = true;
        lifted = true;
      }
    }
    if (!changed) return;
    // The cap's reset is a known instant: arm for it, as for any stated reset.
    creditResume.arm();
    if (lifted) creditResume.credentialChanged('a Bedrock cap was raised above its spend');
    emit(buildAccountReport());
  };

  /** The last snapshot's Claude accounts, to tell a refresh on this host from the server's. */
  let sharedClaude: SharedSecrets['claude'] = [];
  /**
   * Claude accounts in the shared settings this host is not sent — Bedrock
   * accounts on another host (`settings.snapshot.claudeHeldElsewhere`). A chat
   * locked to one is refused here, not moved onto this host's accounts.
   */
  let claudeHeldElsewhere: NonNullable<SettingsSnapshotEvent['claudeHeldElsewhere']> = [];

  /**
   * Apply one `settings.snapshot`. Each part is applied on its own: a part that
   * cannot be applied is named in the returned error, and the rest still take
   * effect, so one refused key does not leave every other setting stale.
   */
  let firstSnapshotApplied = false;
  const warmModelCatalog = (when: string): void => {
    void modelCatalog.get().catch((err: unknown) => {
      logger.warn(
        { err: (err as Error).message },
        `model catalogue read failed on ${when}; pickers open empty until it succeeds`,
      );
    });
  };
  /**
   * Where each provider's shared accounts go on this host, keyed like the shared
   * settings' lists (`accountsKey`). Adding a provider with accounts is one entry.
   */
  const sharedAccountStores: {
    [K in ProviderAccountsKey]: (accounts: SharedSecrets[K]) => void | Promise<void>;
  } = {
    claude: (accounts) => {
      const before = claudeAccountsIdentity(readPatchStore(oauthOpts)?.accounts ?? []);
      // The active account (what a check with no account resolves) is a token
      // account where there is one: a Bedrock profile has no token.
      const active = accounts.find((a) => a.bedrock === undefined) ?? accounts[0];
      writePatchStore({ accounts, activeAccountId: active?.id ?? null }, oauthOpts);
      sharedClaude = accounts;
      // A Bedrock account's spend moves with every turn; that alone is not new
      // keys, only (perhaps) a cap reached or lifted.
      if (claudeAccountsIdentity(accounts) !== before) {
        void bedrockSignIn.checkAll();
        // The keys changed: every out-of-credit reading is about keys that may
        // no longer be the ones held, so it is dropped and read afresh.
        accountRotation.clearAll();
        void accountUsage?.refreshAll(true);
        creditResume.credentialChanged('shared accounts changed');
        void refreshCredentialState();
      }
      syncBedrockCaps(accounts);
    },
    codex: (accounts) => codexAccounts.applyShared(accounts),
  };
  /**
   * spec/10 § Provider settings: write what the user chose for each provider's
   * own settings into its own files on this host, and each installed ACP
   * agent's into the file it declares. Nothing chosen, nothing written. Throws
   * naming every file that could not be written, after writing the rest.
   */
  const applyProviderOwnSettings = (shared: SharedSettings): void => {
    const failed: string[] = [];
    const apply = (
      label: string,
      files: OwnConfigFile[],
      format: 'json' | 'toml',
      settings: readonly OwnSetting[],
      chosen: Record<string, number> | undefined,
    ): void => {
      try {
        const written = applyOwnSettings(files, format, settings, chosen).filter(
          (w) => w.written.length > 0,
        );
        if (written.length > 0)
          logger.info({ written }, `${label}'s own settings written from Settings`);
      } catch (err) {
        failed.push(`${label}: ${(err as Error).message}`);
      }
    };
    for (const provider of PROVIDERS as readonly ProviderDescriptor[]) {
      if (provider.ownConfigFormat === undefined || provider.settings.length === 0) continue;
      apply(
        provider.label,
        providerAdapters[provider.id as HarnessId].ownConfigs(),
        provider.ownConfigFormat,
        provider.settings,
        shared.providerSettings[provider.id],
      );
    }
    for (const agent of acpRegistry.installed()) {
      const own = agent.ownSettings;
      if (!own) continue;
      const home = (own.homeEnv !== undefined ? process.env[own.homeEnv] : undefined) || homedir();
      apply(
        agent.label,
        [ownConfigFile(join(home, own.file))],
        'json',
        own.settings,
        shared.providerSettings[acpSettingsId(agent.id)],
      );
    }
    if (failed.length > 0) throw new Error(`could not be written: ${failed.join('; ')}`);
  };
  const applySnapshot = async (snapshot: SettingsSnapshotEvent): Promise<string | undefined> => {
    const errors: string[] = [];
    const part = async (name: string, run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
        logger.error(
          { part: name, err: (err as Error).message },
          'shared settings: part not applied',
        );
      }
    };
    // Provider keys go first: a speech engine named in the settings is checked
    // against the keys this snapshot carries, so they must already be held.
    await part('provider keys', () => {
      try {
        providerKeys.replaceAll(snapshot.secrets.providerKeys);
      } catch (err) {
        if (err instanceof ProviderKeyError) throw new Error(err.message);
        throw err;
      }
    });
    // Before the settings, which apply the endpoints the keys belong to.
    await part('model endpoint keys', () => {
      endpointKeys = snapshot.secrets.endpointKeys;
    });
    await part('ACP accounts', () => {
      if (acpAccounts.apply(snapshot.secrets.acp ?? [])) onAcpChange();
    });
    await part('settings', () => applySharedHostSettings(snapshot.settings));
    claudeHeldElsewhere = snapshot.claudeHeldElsewhere ?? [];
    // Each provider with accounts takes its own list, through its entry in
    // `sharedAccountStores`; the loop names no provider.
    const applyAccounts = <K extends ProviderAccountsKey>(key: K): void | Promise<void> =>
      sharedAccountStores[key](snapshot.secrets[key]);
    for (const provider of ACCOUNT_PROVIDERS) {
      await part(`${provider.label} accounts`, () => applyAccounts(provider.accountsKey));
    }
    // After the accounts: a provider's own files include each account's. A file
    // that cannot be written is reported back in `settings.applied`.
    await part('provider settings', () => applyProviderOwnSettings(snapshot.settings));
    link.send(buildAccountReport());
    publishHost();
    if (!firstSnapshotApplied) {
      firstSnapshotApplied = true;
      // The accounts are known now: a park the restart carried over is released
      // where it may run, and its reset re-armed where it is still ahead
      // (spec/10 § Limits). Nothing else would wake it: no timer survived the
      // restart, and a usage reading may never come.
      daemon.releaseRestoredParks();
      // The first account and key sync is in: only now is a missing credential
      // or an unreadable catalogue a real fault rather than a host still starting.
      const result = await resolveOAuth();
      if (!result.ok) {
        logger.error(
          { err: result.reason },
          'patch-daemon: Claude OAuth not ready after the first account sync',
        );
      }
      warmModelCatalog('first sync');
    }
    logger.info({ version: snapshot.version, errors }, 'shared settings: snapshot applied');
    return errors.length ? errors.join('; ') : undefined;
  };

  /**
   * Send a value this host holds up to the server (spec/01 § Settings —
   * values that start on a host). `import` is everything held before settings
   * were shared, asked once per host.
   */
  const answerAdopt = async (
    request: SettingsAdoptRequestEvent,
  ): Promise<SettingsAdoptResponseEvent> => {
    const base = {
      type: 'settings.adopt.response' as const,
      requestId: request.requestId,
      hostId: selfHostId,
    };
    try {
      switch (request.kind) {
        case 'import': {
          const state = hostStateStore.get();
          const settings: SharedSettingsPatch = {
            ...(state.permissionModeDefault
              ? { permissionModeDefault: state.permissionModeDefault }
              : {}),
            ...(state.kokoroVoice ? { kokoroVoice: state.kokoroVoice } : {}),
            ...(state.ttsBackend ? { ttsBackend: state.ttsBackend } : {}),
            ...(state.elevenLabsVoice ? { elevenLabsVoice: state.elevenLabsVoice } : {}),
            ...(state.elevenLabsModel ? { elevenLabsModel: state.elevenLabsModel } : {}),
            chatNameInterval,
            titleGenerationEnabled,
            statusGenerationEnabled,
            autoResumeRateLimit,
            limitBehaviour,
            questionExpiry,
            questionExpirySeconds,
            questionExpiredPrompt,
            harnessSystemPrompt: harnessSystemPrompt ?? '',
            harnessToolsPrompt: harnessToolsPrompt ?? null,
            harnessSkills: harnessSkills ?? null,
            harnessMemoryEnabled,
          };
          const store = readPatchStore(oauthOpts);
          return {
            ...base,
            ok: true,
            result: {
              kind: 'import',
              import: {
                settings,
                secrets: {
                  claude: (store?.accounts ?? []).map((a) => ({
                    id: a.id,
                    label: a.label,
                    credential: a.credential
                      ? {
                          accessToken: a.credential.accessToken,
                          ...(a.credential.refreshToken
                            ? { refreshToken: a.credential.refreshToken }
                            : {}),
                          ...(a.credential.expiresAt !== undefined
                            ? { expiresAt: a.credential.expiresAt }
                            : {}),
                          ...(a.credential.email ? { email: a.credential.email } : {}),
                          ...(a.credential.organizationId
                            ? { organizationId: a.credential.organizationId }
                            : {}),
                        }
                      : null,
                  })),
                  codex: codexAccounts.exportAll(),
                  providerKeys: providerKeys.settingsKeys(),
                },
              },
            },
          };
        }
        case 'claude-login': {
          const legacy = loadLegacyClaudeOAuth(
            config.claudeCredentialsPath !== undefined
              ? { path: config.claudeCredentialsPath }
              : {},
          );
          return {
            ...base,
            ok: true,
            result: {
              kind: 'claude-login',
              account: {
                id: randomUUID(),
                label: legacy.email ?? `Claude (${hostName})`,
                credential: {
                  accessToken: legacy.accessToken,
                  ...(legacy.refreshToken ? { refreshToken: legacy.refreshToken } : {}),
                  ...(legacy.expiresAt !== undefined ? { expiresAt: legacy.expiresAt } : {}),
                  ...(legacy.email ? { email: legacy.email } : {}),
                },
              },
            },
          };
        }
        case 'codex-login':
          return {
            ...base,
            ok: true,
            result: { kind: 'codex-login', account: await codexAccounts.exportHostLogin() },
          };
        case 'provider-key': {
          const parsed = ProviderKeyId.safeParse(request.id);
          if (!parsed.success) throw new Error(`no provider key ${request.id ?? '(none)'}`);
          const value = providerKeys.envValue(parsed.data);
          if (!value) throw new Error(`${hostName} has no ${parsed.data} key in its environment`);
          return { ...base, ok: true, result: { kind: 'provider-key', id: parsed.data, value } };
        }
        case 'codex-signin':
          throw new Error('a ChatGPT sign-in is started with host.backend_add_account');
      }
    } catch (err) {
      logger.warn(
        { kind: request.kind, err: (err as Error).message },
        'shared settings: nothing to send up',
      );
      return { ...base, ok: false, error: (err as Error).message };
    }
  };

  /**
   * Credentials refreshed on this host while running turns go to the server,
   * which stores them and sends them to every other host (spec/01 § Settings).
   * Checked on a timer rather than hooked into each refresh path, so a refresh
   * done by Claude Code or Codex themselves is caught as well as patch's own.
   */
  const reportRefreshedCredentials = (): void => {
    if (sharedClaude.length > 0) {
      for (const account of readPatchStore(oauthOpts)?.accounts ?? []) {
        const shared = sharedClaude.find((a) => a.id === account.id);
        if (!shared?.credential || !account.credential) continue;
        if (account.credential.accessToken === shared.credential.accessToken) continue;
        const credential = {
          ...shared.credential,
          accessToken: account.credential.accessToken,
          ...(account.credential.refreshToken
            ? { refreshToken: account.credential.refreshToken }
            : {}),
          ...(account.credential.expiresAt !== undefined
            ? { expiresAt: account.credential.expiresAt }
            : {}),
        };
        shared.credential = credential;
        link.send({
          type: 'settings.secret_update',
          hostId: selfHostId,
          update: { backendId: 'claude-code', accountId: account.id, credential },
        });
      }
    }
    for (const refreshed of codexAccounts.refreshedLogins()) {
      link.send({
        type: 'settings.secret_update',
        hostId: selfHostId,
        update: { backendId: 'codex', ...refreshed },
      });
    }
  };
  const credentialReportTimer = setInterval(reportRefreshedCredentials, 60_000);
  credentialReportTimer.unref();

  // Heartbeat health (spec/03 § Host health): tell the server how this host
  // is coping, and hold new turns while its memory is critically short — work
  // started now would only be cut off when the kernel kills something.
  const healthSampler = createHealthSampler();
  let memoryCritical = false;
  const reportHealth = async (): Promise<void> => {
    let sample: Awaited<ReturnType<typeof healthSampler.sample>>;
    try {
      sample = await healthSampler.sample();
    } catch (err) {
      logger.error({ err }, 'host health: could not sample this host');
      return;
    }
    const critical = assessHostHealth(sample).critical;
    if (critical !== memoryCritical) {
      memoryCritical = critical;
      logger.warn(
        { critical },
        critical
          ? 'host health: memory critical, holding new turns'
          : 'host health: memory recovered, releasing held turns',
      );
      if (!critical) daemon.releaseHeldTurns();
    }
    if (linkOnline) {
      link.send({
        type: 'host.health',
        hostId: selfHostId,
        ...sample,
      });
    }
  };
  const healthTimer = setInterval(() => void reportHealth(), HOST_HEALTH_INTERVAL_MS);
  healthTimer.unref();

  // Update probation: while this build is the one on trial, prove it is
  // connected, every 10s. The watchdog (another process) is the judge.
  const probationTimer = setInterval(() => {
    if (!linkOnline) return;
    try {
      recordAlive(config.patchHome, VERSION);
    } catch (err) {
      logger.error({ err }, 'self-update: could not record the probation heartbeat');
    }
  }, 10_000);
  probationTimer.unref();

  // The one-off send of what the server's record lacks (spec/01 § Chat record).
  // Built once the chats are loaded, below; started by a server that takes it.
  let recordImport: RecordImport | undefined;
  // The same one-off send for `patch_agent` subagents' records, each kept
  // against its parent, to a server that keeps them (`delegateRecord`).
  let delegateRecordImport: RecordImport | undefined;
  // Every cross-chat tool call, for the account's tool log (Settings →
  // Activity, spec/06 § Cross-chat toolset): kept on this host until the
  // server on the link keeps the log (`serverReads`), then sent through the
  // outbox, the local file handed over once.
  const toolLogSink = new ToolLogSink(config.patchHome, (event) => link.send(event));
  sendAcpReport = () => link.send(acpAccounts.report(selfHostId, ACP_BACKEND_ID));
  // Transcript events and Bedrock spend wait here until the server acknowledges
  // them; the spend still owed counts against the cap (`bedrockAtCap`).
  const hostOutbox = new Outbox({
    path: join(config.patchHome, 'outbox.jsonl'),
    logger,
    // A spend acknowledged is no longer owed: a cap counted with it may lift.
    onAck: () => syncBedrockCaps(sharedClaude),
  });
  const link = createServerLink({
    url: config.serverWsUrl,
    daemonKey,
    outbox: hostOutbox,
    clientVersion: VERSION,
    clientGitSha: GIT_SHA,
    clientBuiltAt: BUILT_AT,
    logger,
    sleepDetector,
    // The server speaks a protocol this build cannot read, so the matching
    // build is (or is about to be) published — go and get it. The update gate
    // joins repeat calls from each reconnect and waits out running turns.
    onGreetingUnreadable: () => {
      void applyUpdateOnce().then(
        (result) =>
          logger.warn(
            { applied: result.applied, deferred: result.deferred, result: result.message },
            'self-update: requested because the server greeting was unreadable',
          ),
        (err: unknown) =>
          logger.error({ err }, 'self-update: failed after an unreadable server greeting'),
      );
    },
    onServerRestarting: swapToStaged,
    onAuthed: (sender, greeting) => {
      linkOnline = true;
      // A rollback happened while this host was away: say so, so it is visible.
      try {
        const failed = takeUpdateFailure(config.patchHome);
        if (failed) {
          logger.error({ ...failed }, 'self-update: the last update was rolled back');
          sender({ type: 'host.update_failed', hostId: selfHostId, ...failed });
        }
      } catch (err) {
        logger.error({ err }, 'self-update: could not read the rolled-back update record');
      }
      // Adopt the account's host roster from the greeting, so a cross-chat
      // call naming another host knows whether that host is up.
      onlineHosts.clear();
      for (const host of greeting.hosts) {
        if (host.online && host.hostId !== selfHostId) onlineHosts.add(host.hostId);
      }
      // Group 8 fix (DX-M1): the server's ChatRegistry is purely in-memory and
      // gated to admit `chat.state` only for chatIds it has previously seen
      // `chat.spawned` for. After a server restart the gate would suppress
      // every chat-state we re-emit. Replay the currently-known chats so the
      // server seeds its registry. (`host.online` is now server-emitted.)
      if (oauth.error) {
        sender({
          type: 'host.unauthenticated',
          hostId: selfHostId,
          backendId: CLAUDE_BACKEND_ID,
          reason: oauth.error.message,
        });
      }
      // spec/02 § Host identity — this host's self-description, so a surface
      // can render the Hosts list from the link alone. The server caches it and
      // replays it in every later surface's auth.ok greeting.
      sender(describeHost());
      // spec/10 § Backend credentials — per (host, backend) credential state,
      // so Settings can say which backend on which host needs a login.
      sender(buildAccountReport());
      sender(codexAccounts.report());
      sender(acpAccounts.report(selfHostId, ACP_BACKEND_ID));
      for (const state of daemon.list()) announceChat(state);
      // spec/04 § Folders: publish the host-owned folder list so every
      // surface's new-chat / schedule-editor picker is populated from the same
      // source. `snapshot()` records the baseline so a later identical
      // `refresh()` won't fire a redundant `folders.updated`.
      // AFTER every chat above: the server reads this host's folders.list as the
      // end of its chat re-announcement, and only then answers a chat it does
      // not know as not found (packages/server/src/unknown-chat.ts).
      // Only the chats this host has loaded were announced in full above; the
      // ids of every other chat tell the server they still exist
      // (spec/02 § Chat loading).
      const folderSnapshot = folderRegistry.snapshot();
      hostStateStore.update({ recentFolders: folderSnapshot.recent.slice(0, 50) });
      sender({
        type: 'folders.list',
        hostId: selfHostId,
        ...folderSnapshot,
        chatIds: daemon.allChatIds(),
      });
      // spec/02 § Claude Code settings: publish this host's settings.json and
      // memory entries on (re)connect, same snapshot-on-connect contract as
      // folders and secrets below.
      sender({ type: 'claude_settings.list', hostId: selfHostId, ...claudeSettingsSnapshot() });
      // spec/07 § A call can move between devices — the calls this host holds
      // right now. The server replaces whatever it last knew for this host, so
      // a call that ended while the link was down does not stay on any
      // surface. No audio server yet means no call can be open.
      sender({ type: 'voice.calls', hostId: selfHostId, calls: audioServer?.liveCalls() ?? [] });
      // spec/02 § Agent backends — warm the catalogue on connect so a picker
      // opens on a real list rather than an empty one. It no longer SEEDS
      // anything: the model a model-less spawn takes is the account default the
      // server pushes, not the newest entry of whatever catalogue this host
      // happened to read first.
      // A host that has not yet had its first account sync has nothing to read
      // the catalogue with; the first snapshot warms it instead.
      if (firstSnapshotApplied) warmModelCatalog('connect');
      // spec/15 § Secrets: publish the host-owned secret set so every
      // surface's editor is populated from the same source on (re)connect.
      sender({ type: 'secrets.list', secrets: secretsStore.list() });
      const handedOver = toolLogSink.onServer(greeting.serverReads === true);
      if (handedOver > 0) {
        logger.info({ entries: handedOver }, 'tool log: handed this host’s log to the server');
      }
      // Only a server that keeps the whole record, each entry's branch with it,
      // takes the full import.
      if (
        greeting.recordImport === true &&
        greeting.recordComplete === true &&
        greeting.recordBranches === true
      ) {
        recordImport?.start();
      }
      if (greeting.delegateRecord === true) delegateRecordImport?.start();
    },
    onFrame: async (event, sender) => {
      // Host addressing, checked once for the whole inbound stream: ANY frame
      // carrying a `hostId` names one host, and this host acts on it only
      // when that host is this one. Reaching here otherwise means the server
      // mis-routed, and obeying it would spawn a chat / edit a registry / open a
      // shell on the wrong host — strictly worse than refusing with both ids
      // named. NO FALLBACK.
      const addressed = isHostAddressedSurfaceEvent(event.type)
        ? (event as { hostId?: unknown }).hostId
        : undefined;
      if (typeof addressed === 'string' && !isForThisHost(addressed, event.type)) {
        // A spawn is the one case a surface is synchronously waiting on, so it
        // gets the refusal as a frame rather than only a log line.
        if (event.type === 'chat.spawn_request') {
          sender({
            type: 'chat.error',
            chatId: event.chatId ?? 'pending-spawn',
            error: {
              code: 'host_not_registered',
              message: `chat.spawn_request addressed to ${addressed}, but this host is ${selfHostId}`,
            },
            seq: OUT_OF_BAND_SEQ,
          });
        }
        return;
      }
      // Jobs RPC responses route directly into the RemoteJobsStore's
      // pending-request map; everything else flows through the surface
      // event handler.
      if (event.type === 'patch.jobs.response') {
        jobs.handleResponse(event);
        return;
      }
      if (event.type === 'patch.artifact.publish_response') {
        artifactPublisher.handleResponse(event);
        return;
      }
      if (event.type === 'host.record_import_ack') {
        recordImport?.onAck(event.chatId);
        delegateRecordImport?.onAck(event.chatId);
        return;
      }
      if (event.type === 'chat.committed') {
        daemon.noteCommitted(event.chatId, event.through);
        return;
      }
      if (event.type === 'host.reconciled') {
        daemon.resumeAfterReconciliation();
        return;
      }
      if (event.type === 'server.queue_mode') {
        queuePull.setEnabled(event.enabled);
        return;
      }
      if (event.type === 'patch.queue_pull.response') {
        queuePull.handleResponse(event);
        return;
      }
      if (event.type === 'patch.api.response') {
        serverApiClient.handleResponse(event);
        return;
      }
      if (event.type === 'patch.events.event') {
        serverEventsClient.handleEvent(event);
        return;
      }
      if (event.type === 'patch.accounts.response') {
        accountsClient.handleResponse(event);
        return;
      }
      if (event.type === 'patch.pad.response') {
        padClient.handleResponse(event);
        return;
      }
      if (event.type === 'patch.files.request') {
        void handleFilesRequest(event, daemon, sender, logger);
        return;
      }
      if (event.type === 'patch.file_op.request') {
        handleFileOpRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc.request') {
        handleDocRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc_action.request') {
        handleDocActionRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc_convert.request') {
        void handleDocConvertRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc_export.request') {
        void handleDocExportRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.background_task_stats.request') {
        // The measurement shells out to `lsof`/`ps`, so it is deliberately not
        // awaited here: a slow process-table scan must not stall the frames
        // queued behind it. The surface's request has its own timeout.
        void handleBackgroundTaskStatsRequest(
          event,
          (chatId) => daemon.chatState.get(chatId) !== undefined,
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.stray_processes.request') {
        handleStrayProcessesRequest(
          event,
          strayProcesses,
          (chatId) => daemon.chatState.get(chatId) !== undefined,
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.watch_list.request') {
        handleWatchListRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            listWatch: (chatId) => daemon.listWatch(chatId),
            stopWatch: (chatId, taskId) => daemon.stopWatch(chatId, taskId),
            setWatchCheckIn: (chatId, taskId, sec) =>
              daemon.setWatchTaskCheckIn(chatId, taskId, sec),
            watchOutput: (chatId, taskId, tail) => daemon.watchOutput(chatId, taskId, tail),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.watch_checkin.request') {
        handleWatchCheckInRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            listWatch: (chatId) => daemon.listWatch(chatId),
            stopWatch: (chatId, taskId) => daemon.stopWatch(chatId, taskId),
            setWatchCheckIn: (chatId, taskId, sec) =>
              daemon.setWatchTaskCheckIn(chatId, taskId, sec),
            watchOutput: (chatId, taskId, tail) => daemon.watchOutput(chatId, taskId, tail),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.watch_output.request') {
        handleWatchOutputRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            listWatch: (chatId) => daemon.listWatch(chatId),
            stopWatch: (chatId, taskId) => daemon.stopWatch(chatId, taskId),
            setWatchCheckIn: (chatId, taskId, sec) =>
              daemon.setWatchTaskCheckIn(chatId, taskId, sec),
            watchOutput: (chatId, taskId, tail) => daemon.watchOutput(chatId, taskId, tail),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.delegate_control.request') {
        void handleDelegateControlRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            isDelegateOf: (parent, id) => daemon.delegateParentOf(id) === parent,
            pause: (parent, id) => daemon.pauseDelegate(parent, id),
            resume: (parent, id) => daemon.resumeDelegate(parent, id),
            stop: (parent, id) => daemon.stopDelegate(parent, id),
            spinOff: (parent, id) => daemon.spinOffDelegate(parent, id),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.watch_stop.request') {
        handleWatchStopRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            listWatch: (chatId) => daemon.listWatch(chatId),
            stopWatch: (chatId, taskId) => daemon.stopWatch(chatId, taskId),
            setWatchCheckIn: (chatId, taskId, sec) =>
              daemon.setWatchTaskCheckIn(chatId, taskId, sec),
            watchOutput: (chatId, taskId, tail) => daemon.watchOutput(chatId, taskId, tail),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.skills.request') {
        void handleSkillsRequest(event, sender, logger);
        return;
      }
      if (event.type === 'patch.backends.request') {
        sender({
          type: 'patch.backends.response',
          requestId: event.requestId,
          hostId: selfHostId,
          backends: describeHost().backends as unknown as Record<string, unknown>[],
          accounts: buildAccountReport().accounts as unknown as Record<string, unknown>[],
          ...(event.forSurfaceId ? { forSurfaceId: event.forSurfaceId } : {}),
        });
        return;
      }
      if (event.type === 'patch.models.request') {
        void handleModelsRequest(
          event,
          modelCatalog,
          sender,
          logger,
          selfHostId,
          codexAccounts,
          modelEndpoints,
          acpRegistry,
        );
        return;
      }
      if (event.type === 'patch.recurrence.translate.request') {
        void handleRecurrenceTranslateRequest(
          event,
          translateRecurrenceRule,
          sender,
          logger,
          selfHostId,
          config.patchHome,
        );
        return;
      }
      if (event.type === 'patch.link_summary.request') {
        void handleLinkSummaryRequest(
          event,
          summariseLink,
          sender,
          logger,
          selfHostId,
          config.patchHome,
        );
        return;
      }
      if (event.type === 'patch.folders.browse.request') {
        void handleFoldersBrowseRequest(event, folderRegistry, sender, logger, selfHostId);
        return;
      }
      if (event.type === 'settings.snapshot') {
        if (!isForThisHost(event.hostId, event.type)) return;
        const error = await applySnapshot(event);
        sender({
          type: 'settings.applied',
          hostId: selfHostId,
          version: event.version,
          ...(error ? { error } : {}),
        });
        return;
      }
      if (event.type === 'settings.adopt.request') {
        if (!isForThisHost(event.hostId, event.type)) return;
        sender(await answerAdopt(event));
        return;
      }
      // spec/10 § Signing in → an ACP agent: the agent's own sign-in, run here.
      if (event.type === 'acp.login_request') {
        if (!isForThisHost(event.hostId, event.type)) return;
        await startAcpLogin(event, sender);
        return;
      }
      if (event.type === 'acp.login_callback') {
        if (!isForThisHost(event.hostId, event.type)) return;
        const run = acpLogins.get(event.loginId);
        const update = (message: string): void =>
          sender({
            type: 'acp.login_update',
            hostId: selfHostId,
            loginId: event.loginId,
            agentId: run?.agentId ?? '',
            status: 'waiting',
            message,
          });
        if (!run) {
          sender({
            type: 'acp.login_update',
            hostId: selfHostId,
            loginId: event.loginId,
            agentId: 'unknown',
            status: 'failed',
            message: 'That sign-in is not running on this host any more',
          });
          return;
        }
        try {
          await run.login.replay(event.url);
          update('Address received; finishing the sign-in…');
        } catch (err) {
          update((err as Error).message);
        }
        return;
      }
      if (event.type === 'acp.login_cancel') {
        if (!isForThisHost(event.hostId, event.type)) return;
        acpLogins.get(event.loginId)?.login.cancel();
        return;
      }
      if (event.type === 'host.claude_settings_set') {
        if (!isForThisHost(event.hostId, event.type)) return;
        try {
          writeClaudeSettingsJson(claudeHome, event.text);
        } catch (err) {
          if (!(err instanceof InvalidSettingsJsonError)) throw err;
          const message = `host.claude_settings_set: ${selfHostId} — ${err.message}`;
          logger.warn({ frameType: event.type }, message);
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'claude_settings_invalid', message },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        logger.info('Claude Code settings.json edited');
        sender({
          type: 'claude_settings.updated',
          hostId: selfHostId,
          ...claudeSettingsSnapshot(),
        });
        return;
      }
      if (event.type === 'patch.chat_move.request') {
        // spec/04 § Moving to another host — retire an old moved copy.
        handleChatMoveRequest(event, daemon, sender, logger, selfHostId);
        return;
      }
      if (event.type === 'patch.folders_check.request') {
        // spec/11 § Replacing a host — which of the old host's folders are here.
        if (!isForThisHost(event.hostId, event.type)) return;
        sender(answerFoldersCheck(event, selfHostId));
        return;
      }
      if (event.type === 'patch.chat_adopt.request') {
        // spec/11 § Replacing a host — take over the old host's chats.
        if (!isForThisHost(event.hostId, event.type)) return;
        sender(answerChatAdopt(event, daemon, logger, selfHostId));
        return;
      }
      if (event.type === 'patch.aws_profile_check.request') {
        // spec/10 § Signing in — Amazon Bedrock: the server checks a profile
        // here before it stores or re-points an account. Names and a yes/no
        // go back; never a credential.
        if (!isForThisHost(event.hostId, event.type)) return;
        void checkAwsProfile(event.awsProfile, { profiles: awsProfilesNow }).then(
          (result) => {
            sender({
              type: 'patch.aws_profile_check.response',
              requestId: event.requestId,
              hostId: selfHostId,
              ...result,
            });
          },
          (err: unknown) => {
            logger.error(
              { awsProfile: event.awsProfile, err: (err as Error).message },
              'AWS profile check failed',
            );
            sender({
              type: 'patch.aws_profile_check.response',
              requestId: event.requestId,
              hostId: selfHostId,
              exists: false,
              signedIn: null,
              error: `The check failed on this host: ${(err as Error).message}`,
            });
          },
        );
        return;
      }
      if (event.type === 'patch.host_files.request') {
        // spec/03 § Host files — the phone's Files screen: read / list / write
        // by absolute path on this host, with no chat in between.
        void handleHostFilesRequest(event, sender, logger, selfHostId, {
          onWritten: (absPath) => daemon.noteHostFileWritten(absPath),
        });
        return;
      }
      if (event.type === 'patch.mcp_app.request') {
        // MCP Apps (SEP-1865): a tool's UI template, and the calls its UI makes.
        void mcpApps.handle(event, sender, selfHostId);
        return;
      }
      if (event.type === 'patch.voiceprint.request') {
        // spec/16 § Who is speaking — enrolment from Settings.
        void handleVoiceprintRequest(event, sender, logger, selfHostId, {
          speakerId,
          recent: recentVoices,
        });
        return;
      }
      if (event.type === 'patch.blob.request') {
        // spec/04 § History — blobs: a tool-output or image body replay
        // deliberately left behind, fetched now that someone is looking at it.
        handleBlobRequest(event, daemon, sender, logger, selfHostId);
        return;
      }
      if (
        event.type === 'patch.terminal.open' ||
        event.type === 'patch.terminal.input' ||
        event.type === 'patch.terminal.signal' ||
        event.type === 'patch.terminal.close' ||
        event.type === 'patch.terminal.resize'
      ) {
        // spec/02 § Terminal sessions. The hub stamped `forSurfaceId`; the
        // session manager echoes it onto every frame it emits so the output
        // stream lands on the one surface driving the shell.
        terminalSend = sender;
        terminals.handle(event);
        return;
      }
      if (event.type === 'patch.host_search.request' || event.type === 'patch.host_search.cancel') {
        // spec/02 § Host search — ⌘⇧F search in files, with no chat in
        // between. Same `forSurfaceId`-stamped streaming pattern as terminal
        // sessions above.
        hostSearchSend = sender;
        hostSearch.handle(event);
        return;
      }
      if (event.type === 'host.wake_request') {
        // spec/08 § Wake host — schedule a macOS wake ahead of a job's fire.
        void handleHostWake(event, sender, logger);
        return;
      }
      if (event.type === 'job.exec_request') {
        // spec/08 § Action — `script`. A job that runs a command on this host
        // instead of starting a chat; the result frame is what settles its run.
        // The command runs detached and outlives a host restart (spec/02 §
        // Host restarts), so its result goes out through the link, not this
        // connection's sender.
        jobRuns.start(event);
        return;
      }
      if (event.type === 'hook.check_request') {
        // spec/20-hooks.md — a user-message hook's check. `routedBackend` and
        // the model-aware OAuth resolution below mirror the real chat-turn
        // path (`resolveOAuth` in the host deps further down this file) so a
        // prompt hook runs on whichever backend its model belongs to, on the
        // same credential gate a real turn uses — never a separate paid call.
        void handleHookCheck(event, sender, {
          sdkBackend: routedBackend,
          resolveOAuth: resolveModelOAuth,
          logger,
        });
        return;
      }
      if (
        event.type === 'patch.voice.direct_transcribe_request' ||
        event.type === 'patch.voice.direct_speak_request'
      ) {
        // spec/07 § Direct calls — a device's cloud speech, on this host's key.
        const deps = {
          key: (p: 'groq' | 'elevenlabs' | 'openai') => providerKeys.get(p),
          logger,
        };
        if (event.type === 'patch.voice.direct_transcribe_request') {
          void handleDirectTranscribe(event, deps, sender);
        } else {
          void handleDirectSpeak(event, deps, sender);
        }
        return;
      }
      if (event.type === 'patch.voice.direct_call_end') {
        // spec/07 § Call cost — a direct call ended on its device: price what its
        // cloud engines were sent, keep it, and leave its line in the chat.
        chatVoice.directCallEnded(
          costDirectCall({
            sessionId: event.callId,
            chatId: event.chatId,
            surfaceKind: event.surfaceKind,
            startedAt: event.startedAt,
            endedAt: event.endedAt,
            usage: event.usage,
          }),
        );
        return;
      }
      if (event.type === 'patch.voice.turn_check_request') {
        // spec/07 § Dictation mode — has the speaker finished? Smart Turn.
        void handleTurnCheck(event, loadTurnDetector, sender, logger);
        return;
      }
      if (event.type === 'patch.voice_note.transcribe_request') {
        // spec/07 § End-to-end voice transport — the mobile voice-note upload
        // path. The server owns the HTTP route + chat.input injection; the
        // host owns Whisper, so it just transcribes the uploaded clip and
        // replies. `whisper` is assigned at step 8 (below); a request arriving
        // before the audio stack is up is reported, not silently dropped.
        let engine: DictationEngine;
        try {
          engine = dictationEngineFor(voiceConfig.dictation, event.surfaceKind, {
            surfaceId: event.surfaceId,
            deviceDictation,
          });
        } catch (err) {
          sender({
            type: 'patch.voice_note.transcribe_response',
            requestId: event.requestId,
            ok: false,
            error: { code: 'internal', message: (err as Error).message },
          });
          return;
        }
        void handleVoiceNoteTranscribe(event, dictationTranscribers, engine, sender, logger);
        return;
      }
      if (event.type === 'patch.attachment.store_request') {
        // spec/14 & spec/15 § Composer — the server round-trips an uploaded
        // attachment's bytes here so the host writes a copy under the chat's
        // dir; a later `chat.input` carrying the ref is then fed into the turn
        // by path. The server owns the HTTP route + serving-copy.
        handleAttachmentStore(event, daemon, sender, logger);
        return;
      }
      if (event.type === 'patch.attachment.delete_request') {
        // Step 3 of 3 — a composer-draft attachment removed before it was
        // ever sent frees its host-side copy too (nothing orphaned on
        // disk).
        handleAttachmentDelete(event, daemon, sender, logger);
        return;
      }
      if (
        event.type === 'patch.secrets.set_request' ||
        event.type === 'patch.secrets.delete_request'
      ) {
        handleSecretsMutation(event, secretsStore, sender, logger);
        return;
      }
      if (event.type === 'chat.focus_change') {
        // A voice call stays on the chat it was started on (spec/07): which chat the
        // surface is looking at does not re-target it.
        // spec/02 § Questions are not approvals: give a pending question's
        // countdown a fresh window on the edge that touches its chat, either
        // way. The hub stamps `forSurfaceId`.
        const forSurfaceId = (event as { forSurfaceId?: string }).forSurfaceId;
        if (forSurfaceId !== undefined) {
          daemon.noteChatFocus(forSurfaceId, event.chatId);
        }
        return;
      }
      if (event.type === 'patch.diag.inject_permission') {
        // DEV/TEST (spec/07 ## Permission prompts during voice): synthesise a
        // permission request so the mid-voice banner + spoken yes/no path is
        // exercisable on the dev stack (tools are auto-approved otherwise).
        daemon.injectPermissionRequest(event.chatId, event.tool, event.description);
        return;
      }
      if (event.type === 'voice.end_call_request') {
        // spec/07 § A call can move between devices — hang up the chat's call
        // on whichever surface holds it; that surface ends it quietly.
        void audioServer?.endOpenCall(event.chatId).catch((err: Error) => {
          logger.error({ err: err.message, chatId: event.chatId }, 'voice.end_call_request failed');
        });
        return;
      }
      if (event.type === 'host.voice_catalog_refresh') {
        if (!isForThisHost(event.hostId, event.type)) return;
        // Answered by the `host.host` the read publishes; a failed read is
        // reported there with its reason.
        void voiceCatalog.refresh(event.provider);
        return;
      }
      if (event.type === 'patch.diag.voice_inject') {
        // DEV/TEST (spec/07): feed a transcribed utterance into the open voice
        // session for this surface, routed to its current focus chat. Proves
        // focus-follow re-routing, drives TTS for barge-in, and resolves a
        // pending permission when the word is yes/no.
        audioServer?.injectUtterance(event.surfaceId, event.text);
        return;
      }
      if (
        (event.type === 'host.backend_add_account' ||
          event.type === 'host.backend_usage_refresh') &&
        event.backendId === CODEX_BACKEND_ID
      ) {
        if (!isForThisHost(event.hostId, event.type)) return;
        try {
          if (event.type === 'host.backend_add_account') await codexAccounts.add(event);
          else await codexAccounts.refresh();
        } catch (error) {
          sender({
            ...codexAccounts.report(),
            credentialError: { kind: 'rejected', message: (error as Error).message },
          });
        }
        return;
      }
      if (event.type === 'host.backend_usage_refresh') {
        if (!isForThisHost(event.hostId, event.type)) return;
        if (refuseUnknownBackend(event.type, event.backendId, sender)) return;
        // `force` past the per-account floor: a person is watching for this
        // number to change, and a silently-skipped refresh reads as a broken
        // button.
        await accountUsage?.refreshAll(true);
        // The usual reason to press Refresh while chats are parked is that
        // money has just gone in. So a reading that comes back spendable on an
        // account this host had recorded as spent is acted on here and now:
        // `force`, because a person asking is an assertion that the situation
        // changed — the same standing as adding a key — and waiting out the
        // probe's own "believe a turn over a reading" gap would make the button
        // look broken in exactly the moment it matters.
        creditResume.resumeIfCreditReturned({ force: true });
        sender(buildAccountReport());
        return;
      }
      if (event.type === 'host.backend_add_account') {
        if (!isForThisHost(event.hostId, event.type)) return;
        // Only a ChatGPT sign-in runs on a host. A Claude account is added
        // through the server, which holds the accounts (spec/01 § Settings).
        const message = `host.backend_add_account: ${event.backendId} accounts are added in Settings → Credit sources, not on a host`;
        logger.warn({ backendId: event.backendId }, message);
        sender({
          type: 'chat.error',
          chatId: 'pending-spawn',
          error: { code: 'invalid_frame', message },
          seq: OUT_OF_BAND_SEQ,
        });
        return;
      }
      if (event.type === 'host.rename') {
        // The SERVER owns the registry entry and has already recorded the new
        // name; this keeps the host's own self-description and CLI in step,
        // and persists it so a restart does not revert the rename.
        if (!isForThisHost(event.hostId, event.type)) return;
        hostName = event.hostName;
        hostStateStore.update({ hostName: event.hostName });
        logger.info({ hostName }, 'host renamed');
        sender(describeHost());
        return;
      }
      if (event.type === 'host.manager_handover') {
        // spec/06 § Changing home — the user made this host the Manager's home.
        // Acted on once per change, even if the server tells it again.
        if (!isForThisHost(event.hostId, event.type)) return;
        if (event.epoch <= (hostStateStore.get().managerEpoch ?? -1)) return;
        hostStateStore.update({ managerEpoch: event.epoch });
        if (!runsManager) {
          runsManager = true;
          hostStateStore.update({ runsManager: true });
        }
        createSpecialThreads();
        announceSpecialThreads();
        // Every special thread carries on from the server's high-water mark,
        // or the server refuses its new entries as clashing with ones it holds.
        const MANAGER_THREAD: SpecialThreadId = 'thread_manager';
        const nextSeqs = event.nextSeqs ?? { [MANAGER_THREAD]: event.nextSeq };
        for (const [chatId, nextSeq] of Object.entries(nextSeqs)) {
          if (chatId !== MANAGER_THREAD) daemon.continueFrom(chatId, nextSeq);
        }
        daemon
          .handOverThread(MANAGER_THREAD, {
            nextSeq: nextSeqs[MANAGER_THREAD] ?? event.nextSeq,
            fromHostName: event.fromHostName,
            toHostName: event.toHostName,
            message: event.message,
            ...(event.folderReset !== undefined ? { folderReset: event.folderReset } : {}),
          })
          .catch((err) => logger.error({ err }, 'manager: handover failed'));
        logger.info({ epoch: event.epoch, nextSeqs }, 'manager: home moved here');
        return;
      }
      if (event.type === 'host.set_manager') {
        // Sent to a host as it attaches and whenever the server moves the
        // Manager: the named host runs it, the rest do not.
        const nowHome = event.hostId === selfHostId;
        if (nowHome !== runsManager) {
          runsManager = nowHome;
          hostStateStore.update({ runsManager: nowHome });
          logger.info({ runsManager }, 'manager-host flag changed');
          if (nowHome) {
            createSpecialThreads();
            announceSpecialThreads();
          }
        }
        sender(describeHost());
        return;
      }
      if (event.type === 'host.settings') {
        if (!isForThisHost(event.hostId, event.type)) return;
        // Only what stays with this host (spec/01 § Settings): its MCP
        // servers name commands and paths on this host. Everything else
        // arrives in the shared settings snapshot.
        if (event.harnessMcpServers !== undefined) {
          // Already validated against `McpServerList` by the wire decode (the
          // server's and this link's): names well-formed and unique, `patch`
          // reserved. A frame that fails it never reaches here — it is refused
          // at decode, naming the offending value.
          harnessMcpServers = event.harnessMcpServers;
          hostStateStore.update({ harnessMcpServers });
          applyHarnessConfig();
          logger.info(
            {
              harnessMcpServers: harnessMcpServers.map((s) => ({
                name: s.name,
                enabled: s.enabled,
              })),
            },
            'MCP server list changed',
          );
        } else if (event.harnessBrowserToolsEnabled !== undefined) {
          // LEGACY toggle from a surface that predates the list: flip the two
          // browser servers it stood for, wherever they still are in the list.
          // Ignored when the same frame carries the list, which is the
          // newer, whole statement of what the user wants.
          harnessMcpServers = withBrowserToolsEnabled(
            harnessMcpServers,
            event.harnessBrowserToolsEnabled,
          );
          hostStateStore.update({ harnessMcpServers });
          applyHarnessConfig();
          logger.info(
            { harnessBrowserToolsEnabled: event.harnessBrowserToolsEnabled },
            'browser MCP servers toggled (legacy harnessBrowserToolsEnabled)',
          );
        }
        if (event.patchMcpEnabled !== undefined) {
          patchMcpEnabled = event.patchMcpEnabled;
          hostStateStore.update({ patchMcpEnabled });
          applyHarnessConfig();
          logger.info({ patchMcpEnabled }, 'patch MCP server toggled');
        }
        if (event.harnessClaudeMdEnabled === false) ignoreClaudeMdOff('host.settings');
        sender(describeHost());
        return;
      }
      if (event.type === 'host.backend_install') {
        if (!isForThisHost(event.hostId, event.type)) return;
        if (event.backendId === CODEX_BACKEND_ID) {
          // Failures are reported on the backend entry by the runtime itself.
          await codexAccounts.runtime.ensure().catch((err: unknown) => {
            logger.error({ err }, 'codex-install: failed');
          });
        } else if (event.backendId === CLAUDE_BACKEND_ID) {
          await installClaudeOnRequest(event.reinstall === true);
        } else {
          refuseUnknownBackend(event.type, event.backendId, sender);
        }
        return;
      }
      if (event.type === 'host.component_install' || event.type === 'host.component_remove') {
        if (!isForThisHost(event.hostId, event.type)) return;
        try {
          if (event.type === 'host.component_install') components.install(event.componentId);
          else components.remove(event.componentId);
        } catch (err) {
          if (err instanceof ComponentNotOfferedError) {
            logger.warn({ componentId: event.componentId }, err.message);
            sender({
              type: 'chat.error',
              chatId: 'pending-spawn',
              error: { code: 'component_not_offered', message: err.message },
              seq: OUT_OF_BAND_SEQ,
            });
            return;
          }
          throw err;
        }
        return;
      }
      if (event.type === 'host.stage') {
        if (!isForThisHost(event.hostId, event.type)) return;
        stageAhead(event.version);
        return;
      }
      if (event.type === 'host.update') {
        if (!isForThisHost(event.hostId, event.type)) return;
        // Apply the published build. A successful apply ends with the service
        // manager restarting this process, so the frames below are only ever
        // reached on refusal — which is exactly when the surface needs words.
        const result = await applyUpdateOnce();
        if (result.deferred) {
          // The surface's button reads "Updating…" until the host reconnects,
          // which is when the held install finally restarts it.
          logger.info({ result: result.message }, 'host.update deferred');
          sender(describeHost());
          return;
        }
        if (!result.applied) {
          logger.warn({ reason: result.message }, 'host.update refused');
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: {
              code: 'invalid_frame',
              message: describeUpdateRefusal(result.message),
            },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        logger.info({ result: result.message }, 'host.update applied');
        sender(describeHost());
        return;
      }
      if (event.type === 'host.folder_add' || event.type === 'host.folder_remove') {
        if (!isForThisHost(event.hostId, event.type)) return;
        const path = expandHome(event.path);
        const refuse = (message: string): void => {
          logger.warn({ path, frameType: event.type }, message);
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'folder_invalid', message },
            seq: OUT_OF_BAND_SEQ,
          });
        };
        if (event.type === 'host.folder_add') {
          // A designated project root has to BE a directory on this host —
          // a path that does not exist would publish a picker entry whose every
          // spawn fails with folder_not_found. NO FALLBACK.
          let isDir = false;
          try {
            isDir = statSync(path).isDirectory();
          } catch {
            isDir = false;
          }
          if (!isDir) {
            refuse(`host.folder_add: no such directory on ${selfHostId}: ${path}`);
            return;
          }
          folderRegistry.register(path);
          logger.info({ path }, 'project root added');
        } else {
          if (!folderRegistry.unregister(path)) {
            refuse(`host.folder_remove: ${selfHostId} has no project root: ${path}`);
            return;
          }
          logger.info({ path }, 'project root removed');
        }
        hostStateStore.update({ folderRoots: folderRegistry.roots() });
        // The registry is a host-owned list: every edit republishes the
        // COMPLETE list to every surface (spec/03 § Host events).
        sender({ type: 'folders.updated', hostId: selfHostId, ...folderRegistry.snapshot() });
        return;
      }
      if (event.type === 'host.claude_memory_delete' || event.type === 'host.claude_memory_set') {
        if (!isForThisHost(event.hostId, event.type)) return;
        const refuse = (message: string): void => {
          logger.warn({ frameType: event.type }, message);
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'claude_settings_invalid', message },
            seq: OUT_OF_BAND_SEQ,
          });
        };
        if (event.type === 'host.claude_memory_set') {
          try {
            setClaudeMemory(config.claudeProjectsRoot, event.project, event.file, event.body);
          } catch (err) {
            if (err instanceof InvalidMemoryRefError || err instanceof MemoryNotFoundError) {
              refuse(`host.claude_memory_set: ${selfHostId} — ${err.message}`);
              return;
            }
            throw err;
          }
          logger.info(
            { project: event.project, file: event.file },
            'Claude Code memory entry edited',
          );
        } else {
          try {
            deleteClaudeMemory(config.claudeProjectsRoot, event.project, event.file);
          } catch (err) {
            if (err instanceof InvalidMemoryRefError || err instanceof MemoryNotFoundError) {
              refuse(`host.claude_memory_delete: ${selfHostId} — ${err.message}`);
              return;
            }
            throw err;
          }
          logger.info(
            { project: event.project, file: event.file },
            'Claude Code memory entry deleted',
          );
        }
        sender({
          type: 'claude_settings.updated',
          hostId: selfHostId,
          ...claudeSettingsSnapshot(),
        });
        return;
      }
      if (event.type === 'patch.spawn') {
        // A cross-host spawn relayed by the server (spec/03 § Cross-chat
        // tools): another host's agent asked for a chat on THIS host.
        if (!isForThisHost(event.hostId, event.type)) return;
        // The outcome goes BACK to the calling host. NO FALLBACK: a refusal
        // that only reaches this host's log leaves the calling agent
        // believing it spawned a chat that does not exist (spec/03 § Cross-chat
        // tools — the call resolves inside the turn, success or failure).
        const spawnRequestId = event.requestId;
        // A preference this host does not hold is refused, never ignored: a
        // chat that quietly ran on another account is the failure this stops.
        if (
          event.preferredAccountId !== undefined &&
          !heldAccountsFor(event.model).some((a) => a.id === event.preferredAccountId)
        ) {
          const message = `account ${event.preferredAccountId} is not one of ${selfHostId}'s accounts for this backend`;
          logger.error({ sourceChatId: event.sourceChatId }, `cross-host patch.spawn: ${message}`);
          if (spawnRequestId !== undefined) {
            sender({
              type: 'patch.spawn.response',
              requestId: spawnRequestId,
              sourceChatId: event.sourceChatId,
              hostId: selfHostId,
              folder: event.folder,
              ok: false,
              error: { code: 'account_not_found', message },
            });
          }
          return;
        }
        void daemon
          .spawnChat({
            folder: event.folder,
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.prompt !== '' ? { prompt: event.prompt } : {}),
            ...(event.preferredAccountId !== undefined
              ? { preferredAccountId: event.preferredAccountId }
              : {}),
            spawnedByChatId: event.sourceChatId,
          })
          .then((chatId) => {
            logger.info(
              { chatId, sourceChatId: event.sourceChatId, folder: event.folder },
              'cross-host patch.spawn created a chat here',
            );
            if (spawnRequestId !== undefined) {
              sender({
                type: 'patch.spawn.response',
                requestId: spawnRequestId,
                sourceChatId: event.sourceChatId,
                hostId: selfHostId,
                folder: event.folder,
                ok: true,
                chatId,
              });
            }
          })
          .catch((err: unknown) => {
            const failure = describeSpawnFailure(err);
            logger.error(
              { err: failure.message, sourceChatId: event.sourceChatId },
              'cross-host patch.spawn failed',
            );
            if (spawnRequestId !== undefined) {
              sender({
                type: 'patch.spawn.response',
                requestId: spawnRequestId,
                sourceChatId: event.sourceChatId,
                hostId: selfHostId,
                folder: event.folder,
                ok: false,
                error: failure,
              });
            }
          });
        return;
      }
      if (event.type === 'patch.spawn.response') {
        // Another host answered THIS host's cross-host `patch_spawn`.
        remoteSpawns.resolve(event);
        return;
      }
      if (event.type === 'patch.list_chats.response') {
        // The server answered this host's account-wide chat listing (only
        // the server sees every host's chats).
        resolveListChats(event);
        return;
      }
      if (event.type === 'voice.timers.response') {
        const waiter = timerWaiters.get(event.requestId);
        timerWaiters.delete(event.requestId);
        waiter?.(event);
        return;
      }
      if (event.type === 'patch.search_chats.response') {
        const waiters = searchWaiters.get(event.sourceChatId);
        const next = waiters?.shift();
        if (waiters && waiters.length === 0) searchWaiters.delete(event.sourceChatId);
        next?.(event);
        return;
      }
      if (event.type === 'patch.activity.response') {
        // The server answered this host's `patch_activity` ask.
        resolveActivity(event);
        return;
      }
      if (event.type === 'patch.browser_use.request') {
        // Settings → Computer use: report whether this host's agent browser
        // is driving it, or (action 'stop') close its windows and cancel it.
        const { requestId, action } = event;
        void (async () => {
          const closed = action === 'stop' ? await daemon.computerUseStop() : undefined;
          const st = daemon.computerUseStatus();
          sender({
            type: 'patch.browser_use.response',
            requestId,
            active: st.active,
            ...(st.action ? { actionLabel: st.action } : {}),
            ...(st.since !== undefined ? { since: st.since } : {}),
            tabs: st.tabs,
            ...(st.lastStoppedAt !== undefined ? { lastStoppedAt: st.lastStoppedAt } : {}),
            ...(closed !== undefined ? { closed } : {}),
          });
        })().catch((err: unknown) => {
          logger.error({ err, requestId }, 'browser_use request failed');
        });
        return;
      }
      if (event.type === 'patch.usage.read.request') {
        // Settings → Usage: this host's probe history and per-chat tokens.
        sender({
          type: 'patch.usage.read.response',
          requestId: event.requestId,
          hostId: selfHostId,
          samples: usageHistory.read(event.since, event.until),
          chats: chatTokens.read(event.since, event.until),
        });
        return;
      }
      if (event.type === 'patch.peek.response') {
        // The server answered this host's `patch_peek`. No requestId is a
        // stray frame this host never sent a request for.
        if (event.requestId !== undefined)
          serverPeeks.resolve({ ...event, requestId: event.requestId });
        return;
      }
      if (event.type === 'patch.history.response') {
        if (event.requestId !== undefined)
          serverHistories.resolve({ ...event, requestId: event.requestId });
        return;
      }
      if (event.type === 'patch.send_to') {
        // Cross-host `patch_send_to`: no requestId is a same-host audit record
        // (never relayed — see cross-host.ts), so nothing to deliver or answer.
        const requestId = event.requestId;
        if (requestId === undefined) return;
        void daemon
          .submitInput({
            chatId: event.targetChatId,
            message: event.message,
            // The id the sender chose, so its reply can be found by it.
            localId: event.localId,
            ...(event.voicePrefix !== undefined ? { voicePrefix: event.voicePrefix } : {}),
            origin: 'machine',
            // The origin host already decided whether its caller was
            // visible — carried over the wire as `revealTarget` rather than
            // re-derived here, since this host cannot see that chat's state.
            // Absent (a sender on an older build) must NOT default to reveal —
            // the whole point of this field is that an unknown caller stays
            // hidden rather than leaking into the main list.
            fromAgent: event.revealTarget === true,
          })
          .then(() => {
            sender({
              type: 'patch.send_to.response',
              requestId,
              sourceChatId: event.sourceChatId,
              targetChatId: event.targetChatId,
              ok: true,
            });
          })
          .catch((err: unknown) => {
            const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'sdk_error';
            sender({
              type: 'patch.send_to.response',
              requestId,
              sourceChatId: event.sourceChatId,
              targetChatId: event.targetChatId,
              ok: false,
              error: { code, message: err instanceof Error ? err.message : String(err) },
            });
          });
        return;
      }
      if (event.type === 'patch.send_to.response') {
        remoteSendTos.resolve(event);
        return;
      }
      if (event.type === 'patch.reply.response') {
        serverReplies.resolve(event);
        return;
      }
      if (event.type === 'patch.stop') {
        // Cross-host `patch_stop`: no requestId is a same-host audit record.
        const requestId = event.requestId;
        if (requestId === undefined) return;
        const answer = (error?: { code: 'chat_not_found' | 'sdk_error'; message: string }): void =>
          sender({
            type: 'patch.stop.response',
            requestId,
            sourceChatId: event.sourceChatId,
            targetChatId: event.targetChatId,
            ok: error === undefined,
            ...(error ? { error } : {}),
          });
        if (!daemon.chatState.has(event.targetChatId)) {
          answer({ code: 'chat_not_found', message: `no such chat: ${event.targetChatId}` });
          return;
        }
        daemon
          .stopChat(event.targetChatId)
          .then(() => answer())
          .catch((err: unknown) =>
            answer({
              code: 'sdk_error',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }
      if (event.type === 'patch.stop.response') {
        remoteStops.resolve(event);
        return;
      }
      if (event.type === 'web_bot_auth.sign_response') {
        if (event.hostId !== selfHostId) return;
        webBotAuthSignatures.resolve(event);
        return;
      }
      if (event.type === 'host.online' || event.type === 'host.offline') {
        // Roster upkeep: a cross-chat call naming a host that is down has to
        // fail INSIDE the turn, which means knowing it is down without asking.
        if (event.type === 'host.online') onlineHosts.add(event.hostId);
        else onlineHosts.delete(event.hostId);
        return;
      }
      if (event.type === 'patch.audio_relay.open') {
        // spec/07 § Voice is a per-host capability: the server has a voice
        // session for a chat on THIS host and no direct address for it, so
        // it is tunnelling the session over this link instead. Bridge it to
        // this host's own local audio WSS.
        audioRelayBridge.handleOpen(event);
        return;
      }
      if (event.type === 'patch.audio_relay.frame' || event.type === 'patch.audio_relay.close') {
        if (event.type === 'patch.audio_relay.frame') audioRelayBridge.handleFrame(event);
        else audioRelayBridge.handleClose(event);
        return;
      }
      if (event.type === 'chat.settings') {
        // spec/03 § `chat.settings` — sets the chat's permission mode. The field
        // is the only thing the frame can say, so a frame without it has nothing
        // to do: refuse it out loud rather than reading it as "return this chat
        // to the host default", which is no longer a thing a chat can do
        // (spec/02 § Permission mode).
        if (event.permissionMode === undefined) {
          logger.warn({ chatId: event.chatId }, 'chat.settings: no permissionMode');
          sender({
            type: 'chat.error',
            chatId: event.chatId,
            error: {
              code: 'invalid_frame',
              message: 'chat.settings carries no permissionMode; there is nothing to set',
            },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        try {
          daemon.setChatPermissionMode(event.chatId, event.permissionMode);
        } catch (err) {
          logger.warn(
            { chatId: event.chatId, err: (err as Error).message },
            'chat.settings: unknown chat',
          );
          sender({
            type: 'chat.error',
            chatId: event.chatId,
            error: { code: 'chat_not_found', message: (err as Error).message },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        logger.info(
          { chatId: event.chatId, permissionMode: event.permissionMode },
          'chat permission mode set',
        );
        // The off-default COUNT is part of this host's self-description.
        sender(describeHost());
        return;
      }
      if (event.type === 'chat.model_request') {
        // spec/04 § Model — run this chat on another model from its NEXT turn.
        // Unlike `chat.settings` there is no "clear" reading: a chat is always
        // on some model, so the field is required and always means "switch".
        const { chatId, model, retry } = event;
        void daemon.setChatModel(chatId, model, retry ? { retry } : undefined).then(
          () => {
            // The acknowledgement is the `chat.state` setChatModel emits, which
            // carries the new model — that is also what makes every OTHER
            // surface holding this chat converge on it.
            logger.info({ chatId, model }, 'chat model changed');
          },
          (err: unknown) => {
            // NO FALLBACK: a refused change leaves the chat on the model it was
            // already running, and says so, rather than rounding to a near
            // match or dropping to this host's last-used model.
            const code = (err as { code?: string }).code ?? 'chat_not_found';
            logger.warn(
              { chatId, model, err: (err as Error).message },
              'chat model change refused',
            );
            sender({
              type: 'chat.error',
              chatId,
              error: { code: code as ChatErrorCode, message: (err as Error).message },
              seq: OUT_OF_BAND_SEQ,
            });
          },
        );
        return;
      }
      if (event.type === 'chat.handoff_recover_request') {
        // A failed in-chat provider switch offered these recoveries. A switch
        // is a new linked chat now (spec/04 § Provider switches), so there is
        // nothing to recover: said, never swallowed.
        sender({
          type: 'chat.error',
          chatId: event.chatId,
          error: {
            code: 'sdk_error',
            message:
              'Provider switches start a new linked chat now; choose the other model again to start one.',
          },
          seq: OUT_OF_BAND_SEQ,
        });
        return;
      }
      if (event.type === 'chat.account_request') {
        // spec/10 § Backend credentials — preferred account, from the chat's
        // next turn. Only an account this host holds for the chat's own
        // backend; the acknowledgement is the `chat.state` that carries it.
        const { chatId, preferredAccountId } = event;
        const chat = daemon.chatState.get(chatId);
        const refuse = (code: ChatErrorCode, message: string): void => {
          logger.warn({ chatId, preferredAccountId, message }, 'chat account change refused');
          sender({ type: 'chat.error', chatId, error: { code, message }, seq: OUT_OF_BAND_SEQ });
        };
        if (!chat) {
          refuse('chat_not_found', `no chat ${chatId} on this host`);
          return;
        }
        if (preferredAccountId !== null) {
          const held = heldAccountsFor(chat.model).map((a) => a.id);
          if (!held.includes(preferredAccountId)) {
            refuse(
              'account_not_found',
              `account ${preferredAccountId} is not one of ${daemon.hostId}'s accounts for this chat's backend (holds: ${held.join(', ') || 'none'})`,
            );
            return;
          }
        }
        daemon.setChatPreferredAccount(chatId, preferredAccountId);
        logger.info({ chatId, preferredAccountId }, 'chat preferred account set');
        return;
      }
      if (event.type === 'chat.effort_request') {
        // spec/04 § Effort — run this chat at another thinking-effort level
        // from its NEXT turn, or clear the override with `effort: null`.
        const { chatId, effort } = event;
        void daemon.setChatEffort(chatId, effort).then(
          () => {
            // The acknowledgement is the `chat.state` setChatEffort emits,
            // which carries the new effort — that is also what makes every
            // OTHER surface holding this chat converge on it.
            logger.info({ chatId, effort }, 'chat effort changed');
          },
          (err: unknown) => {
            // NO FALLBACK: a refused change leaves the chat's effort exactly
            // as it was.
            const code = (err as { code?: string }).code ?? 'chat_not_found';
            logger.warn(
              { chatId, effort, err: (err as Error).message },
              'chat effort change refused',
            );
            sender({
              type: 'chat.error',
              chatId,
              error: { code: code as ChatErrorCode, message: (err as Error).message },
              seq: OUT_OF_BAND_SEQ,
            });
          },
        );
        return;
      }
      void handleServerEvent(event, daemon, sender, logger, {
        buildAccountReport,
        heldAccounts: (model) => heldAccountsFor(model).map((a) => a.id),
        meetings,
        speechSetUp: () =>
          voiceConfig.meeting !== 'local' ||
          (whisper !== undefined && !(whisper instanceof UnconfiguredWhisperBackend)),
      });
    },
    onDisconnected: () => {
      linkOnline = false;
      recordImport?.stop();
      delegateRecordImport?.stop();
      serverEventsClient.endAll('host→server link dropped');
      serverReplies.failAll(
        'host_not_registered',
        'the link to the Patch server dropped before the reply came',
      );
      artifactPublisher.failAll(
        'artifact publish: host→server link dropped before the server answered',
      );
    },
  });

  // Group 13: the voice reply bridge — reads a voice turn's streaming +
  // final assistant text off this host's own outbound event stream. See
  // audio/replyBridge.ts for why a waiter must be ARMED (chat observed
  // `running`) before it may settle: resolving on any idle `chat.state`
  // resolved instantly with an empty reply and dropped every delta, which is
  // what left voice sessions with zero `audio.tts_chunk` frames.
  const voiceReplies = createVoiceReplyBridge();

  // spec/07 § Keeping voice and text as one conversation / § Call cost.
  // `daemon` and `audioServer` are read lazily: both exist by the time a
  // voice session or a chat message reaches this.
  // spec/07 § Keeping voice and text as one conversation — a call's catch-up, a small job.
  const voiceCatchUp = (chatId: string, earlier: StartMessage[]): Promise<string> =>
    makeVoiceCatchUp({
      sdkBackend,
      runOnAccountWithCredit: runOnAnyAccount,
      smallJobModels: () => smallJobModels,
      folderOf: (id) => {
        const state = daemon.chatState.get(id);
        if (!state) throw new Error(`chat ${id} is not on this host`);
        return state.folder;
      },
      logger,
    })(chatId, earlier);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  // The whole account, as patch_list_chats lists it: a list missing other hosts' chats
  // would read as "there is no such chat". The status is the server's, for every
  // chat alike (spec/12 § Chat status); this host's own view never overrides it.
  const listAccountChats = async (callerChatId: string): Promise<ChatEntry[]> => {
    // Archived chats too: a call finds and names them like any other, labelled.
    const account = await requestAccountChats(callerChatId, 'include');
    return account.map((e) => {
      const chatStatus = e['chatStatus'];
      const state =
        chatStatus !== null && typeof chatStatus === 'object'
          ? str((chatStatus as Record<string, unknown>)['state'])
          : undefined;
      const lastUpdated = e['lastUpdated'];
      return {
        chatId: e.chatId,
        name: str(e['name']) ?? null,
        folder: str(e['folder']) ?? '',
        status: str(e['status']) ?? 'active',
        ...(state !== undefined ? { chatStatus: state } : {}),
        ...(typeof lastUpdated === 'number' ? { lastUpdated } : {}),
      };
    });
  };
  // One lookup for every call, the Manager's and an ordinary chat's: the same
  // server-routed list and peek every chat agent's patch tools use.
  const chatLookup = createChatLookup({
    listChats: listAccountChats,
    peekChat: async (chatId, callerChatId) =>
      (await peekFromServer({ sourceChatId: callerChatId, targetChatId: chatId, limit: 1 }))
        .chat_state,
  });
  // spec/07 § The voice agent and the chat's agent — every call sends to other
  // chats itself, as `patch_send_to` does, and reads their replies from the
  // server's record, so a chat on any host answers into the call.
  // The Daemon is built later in boot; this only runs once a call is up.
  const deliverToChat = createChatDelivery({
    daemon: {
      submitInput: (req) => daemon.submitInput(req),
      get chatState() {
        return daemon.chatState;
      },
    },
    runsManager: () => runsManager,
    sendToRemoteChat,
    emitWire: (event) => emit(event),
  });
  const chatVoice = createChatVoice({
    daemon: {
      recordVoiceMessage: (r) => daemon.recordVoiceMessage(r),
      reserveVoiceSeq: (chatId) => daemon.reserveVoiceSeq(chatId),
      emitVoiceDelta: (chatId, seq, delta) => daemon.emitVoiceDelta(chatId, seq, delta),
      recordCallSummary: (chatId, line) => daemon.recordCallSummary(chatId, line),
      recordCallNote: (chatId, line) => daemon.recordCallNote(chatId, line),
      recordVoiceHandoff: (handoff) => daemon.recordVoiceHandoff(handoff),
      sendInput: (req) => daemon.sendInput(req),
      voiceStartFacts: (chatId, recent) => daemon.voiceStartFacts(chatId, recent),
      lastAgentMessage: (chatId) => daemon.lastAgentMessage(chatId),
      chatActivity: (chatId) => daemon.chatActivity(chatId),
      searchChat: (chatId, query) => daemon.searchChat(chatId, query),
      getPendingPermissionForChat: (chatId) => daemon.getPendingPermissionForChat(chatId),
      submitPermissionResponse: (r) => daemon.submitPermissionResponse(r),
    },
    sessionsOnChat: (chatId) => audioServer?.sessionsOnChat(chatId) ?? [],
    sessionById: (sessionId) => audioServer?.sessionById(sessionId),
    catchUp: (chatId, earlier) => voiceCatchUp(chatId, earlier),
    lookup: chatLookup,
    deliver: ({ callerChatId, chatId, message, localId }) =>
      deliverToChat({ callerChatId, chatId, message, localId, revealTarget: true }),
    awaitReply: ({ callerChatId, chatId, localId }) =>
      replyFromServer({ sourceChatId: callerChatId, targetChatId: chatId, localId }),
    isLocal: (chatId) => daemon.chatState.has(chatId),
    endCall: (sessionId) => {
      if (!audioServer) throw new Error('the audio server is not running');
      audioServer.endSession(sessionId);
    },
    retargetCall: (sessionId, chatId) => {
      if (!audioServer) throw new Error('the audio server is not running');
      audioServer.retargetCall(sessionId, chatId);
    },
    ledger: voiceLedger,
    logger,
    onCosted: () => publishHost(),
    lookupRealCharge: async (conversationId) => {
      const apiKey = providerKeys.get('elevenlabs');
      if (!apiKey) throw new Error('no ElevenLabs key on this host');
      const charge = await fetchConversationCharge({ apiKey }, conversationId);
      let plan: PlanCredits | undefined;
      let leftError: string | undefined;
      try {
        plan = await fetchPlanCredits({ apiKey });
        elevenLabsPlan = plan;
      } catch (err) {
        leftError = (err as Error).message;
        logger.error({ err: leftError }, 'voice: could not read ElevenLabs credits left');
      }
      return {
        credits: charge.credits,
        usd: plan?.usageBilled ? charge.usd : null,
        creditsLeft: plan ? plan.left : null,
        ...(leftError ? { leftError } : {}),
      };
    },
  });
  /** Run a command-line tool for a Manager-call action; its failure is the action's failure. */
  const runTool = (cmd: string, args: string[], what: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 30_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        if (err) {
          const why = (stderr || err.message).trim().split('\n').slice(-3).join(' ');
          logger.error({ cmd, err: why }, 'manager voice: tool failed');
          reject(new Error(`The ${what} did not answer: ${why}`));
          return;
        }
        resolve(stdout);
      });
    });
  const managerVoice = createManagerVoiceTools({
    logger: logger.child({ component: 'manager-voice' }),
    voicePrompt: () => managerVoicePrompt,
    lookup: chatLookup,
    timers: requestTimers,
    addTask: async ({ content, due, project }) =>
      (
        await runTool(
          'td',
          [
            'task',
            'add',
            content,
            ...(due ? ['--due', due] : []),
            ...(project ? ['--project', project] : []),
          ],
          'to-do list',
        )
      ).trim() || `Added "${content}"${project ? ` to ${project}` : ''}.`,
    listTasks: async (project) => {
      const out = await runTool(
        'td',
        ['task', 'list', '--all', '--json', ...(project ? ['--project', project] : [])],
        'to-do list',
      );
      const parsed = JSON.parse(out) as {
        results?: Array<{ id: string; content: string }>;
        error?: { message?: string };
      };
      if (!parsed.results) {
        throw new Error(`The to-do list did not answer: ${parsed.error?.message ?? out.trim()}`);
      }
      return parsed.results.map((t) => ({ id: t.id, content: t.content }));
    },
    closeTask: async (id) => {
      await runTool('td', ['task', 'complete', `id:${id}`], 'to-do list');
    },
    deleteTask: async (id) => {
      await runTool('td', ['task', 'delete', `id:${id}`, '--yes'], 'to-do list');
    },
    calendar: (args) => {
      const script = process.env['PATCH_CALENDAR_SCRIPT'];
      if (!script) {
        return Promise.reject(
          new Error('The calendar is not set up on this host (PATCH_CALENDAR_SCRIPT is not set).'),
        );
      }
      return runTool('node', [script, ...args], 'calendar');
    },
    askAgent: async (request) => {
      await daemon.submitInput({
        chatId: MANAGER_CHAT_ID,
        message: request,
        localId: `manager-voice-agent-${Date.now()}`,
        origin: 'machine',
      });
    },
    recordNote: (line) => {
      try {
        daemon.recordCallNote(MANAGER_CHAT_ID, line);
      } catch (err) {
        logger.error(
          { err: (err as Error).message },
          'manager voice: could not write into the Manager chat',
        );
      }
    },
  });
  let artifactAutoRepublisher: ArtifactAutoRepublisher | undefined;
  function emit(event: import('@patch/wire').WireEvent): void {
    forward(event);
    // spec/04 § Folders: a freshly-spawned chat may sit in a folder the
    // published list doesn't have yet. Recompute; `refresh` emits a
    // `folders.updated` only when the set actually changed.
    if (event.type === 'chat.spawned') folderRegistry.refresh();
  }
  /**
   * `emit` without the folder recompute. For re-announcing a chat the host
   * already lists: its folder is already counted, and `refresh` walks every
   * chat, so recomputing per re-announced chat froze a host with thousands of
   * chats for a minute on each reconnect — long enough to be dropped as silent.
   */
  function forward(event: import('@patch/wire').WireEvent): void {
    // spec/14 § Artifacts — editing a published page's source republishes it.
    artifactAutoRepublisher?.observe(event);
    // spec/02 § Native subagent dispatch — a `patch_delegate` subagent is never
    // on the wire. `Daemon.emit` withholds its own frames, but title, status,
    // permission and notify frames reach here by other routes, so gate every
    // chat-addressed frame. `chat.delegate_update` carries the PARENT's id.
    const addressed = (event as { chatId?: unknown }).chatId;
    if (typeof addressed === 'string' && daemon.isSubagent(addressed)) return;
    voiceReplies.observe(event);
    chatVoice.observe(event);
    link.send(event);
  }
  /**
   * A chat's SDK query reported the session/week usage of THE KEY THAT TURN IS
   * RUNNING ON (spec/10 § Surface in Settings — Usage — "usage is reported per
   * host per account").
   *
   * Attributed to the account the host handed that turn, which is the only
   * account involved: a chat has none of its own. A turn whose credential
   * carried no account id (no store wiring at all — the mock backend in tests)
   * drops the reading rather than guessing an id.
   */
  const reportUsage = (
    chatId: string,
    scope: 'session' | 'week',
    window: RateLimitWindow,
  ): void => {
    const accountId = daemon.accountRunningOn(chatId);
    if (accountId === undefined) return;
    accountUsage?.observeFromTurn(accountId, scope, window);
  };

  // 4. Host (chat_state owner).
  const metaStore = createMetaStore(config.patchHome);
  // Once: the pre-migration copies of chats' Claude transcripts (spec/04 § History).
  removeRetiredNativeCopies({
    patchHome: config.patchHome,
    folderOf: (chatId) => {
      try {
        return metaStore.read(chatId)?.folder;
      } catch (err) {
        logger.warn({ chatId, err: (err as Error).message }, 'chat meta unreadable');
        return undefined;
      }
    },
    logger,
  });
  removeRetiredTelegramFolder(config.patchHome, logger);
  const usageHistory = new UsageHistoryStore(config.patchHome);
  const chatTokens = new ChatTokenReader(join(config.patchHome, 'chats'));
  /**
   * The stdio MCP server every SDK query launches (spec/02 § MCP server). It
   * sits beside this module — as `.js` in a built host, as `.ts` when the
   * host itself is running from source under a TypeScript loader. Resolving
   * the wrong one silently costs every chat its patch_* toolset (the SDK just
   * reports "no such tools"), so the file is resolved HERE and its absence is a
   * boot failure rather than a mystery at turn time. NO FALLBACK.
   */
  const mcpBin = ((): { command: string; args: string[] } => {
    const here = dirname(fileURLToPath(import.meta.url));
    const built = resolve(here, 'bin', 'patch-tools-server.js');
    if (existsSync(built)) return { command: process.execPath, args: [built] };
    const source = resolve(here, 'bin', 'patch-tools-server.ts');
    if (existsSync(source)) {
      // Running from source: launch the child through the same TypeScript
      // loader this process was started with.
      //
      // The loader MUST be an absolute file: URL, not the bare specifier
      // `tsx`. The SDK spawns this child with the CHAT FOLDER as its cwd, and
      // a bare specifier resolves from there — any folder outside this repo
      // (i.e. every real chat folder) fails with ERR_MODULE_NOT_FOUND and the
      // chat silently loses its whole patch_* toolset. Resolve it here, from
      // this module, so the path is the host's own tsx. NO FALLBACK.
      const tsxLoader = createRequire(import.meta.url).resolve('tsx');
      return {
        command: process.execPath,
        args: ['--import', pathToFileURL(tsxLoader).href, source],
      };
    }
    throw new Error(
      `patch-daemon: MCP server not found at ${built} or ${source} — every chat would lose its patch_* tools`,
    );
  })();
  /**
   * The per-turn runner every Claude turn is started under (spec/02 § Turns
   * outlive the host). Resolved like the MCP server, and for the same reason:
   * a missing runner must stop the boot, not fail every turn later. Only the
   * real backend runs claude, so only it needs one.
   */
  const durableTurns = ((): DurableTurnConfig | undefined => {
    if (config.sdkBackend !== 'real') return undefined;
    const here = dirname(fileURLToPath(import.meta.url));
    const built = resolve(here, 'bin', 'turn-runner.js');
    const source = resolve(here, 'bin', 'turn-runner.ts');
    const turnsDir = join(config.patchHome, 'turns');
    if (existsSync(built)) {
      return { turnsDir, runner: { command: process.execPath, args: [built] } };
    }
    if (existsSync(source)) {
      const tsxLoader = createRequire(import.meta.url).resolve('tsx');
      return {
        turnsDir,
        runner: {
          command: process.execPath,
          args: ['--import', pathToFileURL(tsxLoader).href, source],
        },
      };
    }
    throw new Error(`patch-daemon: turn runner not found at ${built} or ${source}`);
  })();
  // Prove the resolved MCP child actually STARTS from an arbitrary cwd — the
  // SDK launches it with the chat folder as its working directory, and a child
  // that dies on startup costs every chat its patch_* tools with no error
  // anywhere (the model simply reports "no such tools"). `--probe` builds the
  // server in-memory, prints its tool list and exits 0, so this is a real
  // end-to-end check of the command, not a file-exists test. NO FALLBACK: a
  // failure here is a boot failure.
  {
    const probeCwd = homedir();
    const probe = spawnSync(mcpBin.command, [...mcpBin.args, '--probe'], {
      cwd: probeCwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (probe.status !== 0) {
      throw new Error(
        `patch-daemon: MCP server child failed to start (${mcpBin.command} ${mcpBin.args.join(' ')} --probe, cwd ${probeCwd}) — every chat would lose its patch_* tools. exit=${String(probe.status)} signal=${String(probe.signal)} stderr=${(probe.stderr ?? '').trim()}`,
      );
    }
    logger.info({ command: mcpBin.command, args: mcpBin.args }, 'MCP tools child verified');
  }
  // spec/02 § Stack: the special threads' working folders live under the host
  // user's own ~/.patch, resolved from HOME and nothing else — never from the
  // working directory, which the service unit does not set.
  const hostCwd = config.patchHome;
  // OAuth gate (spec/10-auth.md): re-read ~/.claude.json on EVERY query so a
  // credential that expired or was deleted after boot is caught. NO FALLBACK to
  // an API key. Shared by the turn path AND the title summariser so both
  // self-refresh from the same source. Under SDK_BACKEND=mock it is a no-op.
  /**
   * Which accounts are out of credit, and what a failing chat moves to next
   * (spec/10-auth.md § Backend credentials — multiple accounts).
   *
   * Priority is the order of the accounts array: failover walks forward from the
   * account that just failed. Persisted in account-availability.json so a
   * restart keeps what it knew.
   */
  const accountAvailabilityPath = join(config.patchHome, 'account-availability.json');
  const accountRotation = new AccountRotation(
    () => Date.now(),
    readAccountExhaustion(accountAvailabilityPath),
    (entries) => writeAccountExhaustion(accountAvailabilityPath, entries),
  );
  /**
   * The one sequence that picks stalled work back up, and the timer that waits
   * for a stated reset (`creditResume.ts`).
   *
   * Declared here, above everything that fires it, because the events that can
   * reveal credit are scattered — a turn failing over, a wire frame, a usage
   * probe — and each of them used to do its own partial version of this.
   */
  const creditResume = new CreditResume({
    rotation: accountRotation,
    resumeParked: () => daemon.resumeAllRateLimited(),
    offerErrored: () => daemon.offerErroredOnExhaustedAccount(),
    refreshUsage: () => void accountUsage?.refreshAll(true),
    hasOrphanedParks: () => daemon.hasOrphanedCreditParks(),
    hasCreditParks: () => daemon.hasCreditParks(),
    report: () => emit(buildAccountReport()),
    readings: () =>
      (readPatchStore(oauthOpts)?.accounts ?? []).flatMap((a) => {
        const entry = accountUsage?.get(a.id);
        return entry === undefined
          ? []
          : [{ accountId: a.id, blocked: entry.reading.blocked, at: entry.reading.at }];
      }),
    logger,
  });
  /**
   * The shared Claude keys as failover sees them, and the route that orders
   * them for one question (spec/10 § Backend credentials — account strategy).
   * `preferredAccountId` is the chat's, when the question is about a chat that
   * named one.
   */
  /**
   * A current usage reading that says this account is at a limit (spec/10 §
   * Account states), so routing skips it before any turn is refused on it. No
   * reading is no limit.
   */
  const usageLimited = (accountId: string): { limited?: { resetsAt?: number } } => {
    const reading = accountUsage?.get(accountId)?.reading;
    if (reading?.blocked !== true) return {};
    const scope = refusingRateLimitScope(reading.windows);
    const resetsAt = scope !== undefined ? reading.windows[scope]?.resetsAt : undefined;
    return { limited: resetsAt !== undefined ? { resetsAt } : {} };
  };
  const claudeRoute = (
    store: NonNullable<ReturnType<typeof readPatchStore>>,
    preferredAccountId?: string,
    sessionAccountId?: string,
    anyAccount?: boolean,
  ): { accounts: FailoverAccount[]; route: RouteOptions } => ({
    accounts: store.accounts.map((a) => ({
      id: a.id,
      // A Bedrock account has no credential: it can run while its profile is signed in.
      connected: a.bedrock !== undefined ? !bedrockSignIn.signedOut(a.id) : a.credential !== null,
      ...(a.auto !== undefined ? { auto: a.auto } : {}),
      ...(bedrockAtCap(a, Date.now()) ? { capped: true } : {}),
      ...usageLimited(a.id),
      ...(a.credential?.organizationId !== undefined
        ? { organizationId: a.credential.organizationId }
        : {}),
    })),
    route: {
      strategy: accountStrategy.claude,
      ...(preferredAccountId !== undefined ? { preferred: preferredAccountId } : {}),
      ...(preferredAccountId !== undefined &&
      claudeHeldElsewhere.some((a) => a.id === preferredAccountId)
        ? { preferredHeldElsewhere: true }
        : {}),
      ...(sessionAccountId !== undefined ? { sessionAccount: sessionAccountId } : {}),
      // A chat locked to one account may run elsewhere while it is spent only
      // when the user chose to continue on another account.
      resumeOnAnyAccount: limitBehaviour === 'other_account' || anyAccount === true,
      weekResetsAt: (id) => accountUsage?.get(id)?.reading.windows.week?.resetsAt,
      utilization: (id) => {
        const w = accountUsage?.get(id)?.reading.windows;
        const values = [w?.session?.utilization, w?.week?.utilization].filter(
          (v): v is number => v !== undefined,
        );
        return values.length ? Math.max(...values) : undefined;
      },
    },
  });
  const failoverAccount = (
    chatId: string,
    spentAccountId: string | undefined,
    message: string,
    limit?: { resetsAt?: number; kind?: string },
  ): string | undefined => {
    const store = readPatchStore(oauthOpts);
    if (!store) return undefined;
    // The key the failing turn actually ran on, as the host handed it out —
    // never the chat's preference, which is only where its walk starts.
    const failed = spentAccountId;
    const { accounts, route } = claudeRoute(
      store,
      daemon.chatState.get(chatId)?.preferredAccountId,
      undefined,
      daemon.runsOnAnyAccount(chatId),
    );
    // A turn refused before it started, because its account was already known
    // to be spent, has taught nothing new: the record (and when it was made,
    // which a later reading is judged against) stays as it was.
    const alreadyKnown =
      failed !== undefined &&
      accountRotation.isExhausted(failed) &&
      (limit?.resetsAt === undefined || limit.resetsAt === accountRotation.exhaustedUntil(failed));
    if (failed !== undefined && !alreadyKnown) {
      // Siblings sharing this account's organisation are marked with it. They
      // share its pool, so they have nothing of their own left to try, and
      // walking onto one is how a single spent account came to be reported as
      // two.
      // The failure's OWN reset instant first — `quotaLimits.resetsAt`, an
      // exact epoch on the same message — and the prose parse only for a
      // provider that states a reset in words and carries no structured field.
      // Reading the sentence first is lossy and one wording change from
      // sidelining an account with no reset at all, which arms nothing.
      const until = limit?.resetsAt ?? parseLimitResetsAt(message, Date.now());
      const marked = accountRotation.markExhaustedWithSiblings(
        accounts,
        failed,
        message.slice(0, 200),
        until,
        limit?.kind === 'billing_error' ? 'out' : 'limit',
      );
      if (marked.length > 1) {
        logger.warn(
          { failed, alsoSidelined: marked.slice(1) },
          'account failover: the key that ran out shares a Claude account with others — they are the same pool, not a fallback',
        );
      }
      // The reset is a known instant, so arm for it here — at the one moment we
      // learn of it — rather than discovering it later by polling. An
      // exhaustion that stated NO reset arms nothing: the usage probe seeing it
      // spendable again is that account's event (`creditResume.ts`).
      creditResume.arm();
      // Ask Anthropic what this account actually has left. The turn's own error
      // says only that it was refused; the probe says by which window and until
      // when, and it works on an account too spent to run anything.
      void accountUsage?.refresh(failed, true);
    }
    // A key that actually HAS credit, or nothing. Peeked with the chat's own route, so it names where the re-run will
    // actually start — the re-run's resolution is what moves a round-robin on.
    const next = accountRotation.usableAccount(accounts, route);
    if (next === undefined) {
      logger.warn(
        {
          chatId,
          failed: failed ?? null,
          accounts: accounts.map((a) => a.id),
          sidelined: accountRotation.snapshot(),
        },
        'account failover: every account is out of credit',
      );
      // The host's credential state has changed in a way a person may need to
      // act on (add or top up an account), so surfaces are told.
      emit(buildAccountReport());
      return undefined;
    }
    emit(buildAccountReport());
    return next;
  };

  const resolveOAuth = makeResolveOAuth(
    config.claudeCredentialsPath !== undefined
      ? {
          sdkBackend: config.sdkBackend,
          claudeCredentialsPath: config.claudeCredentialsPath,
          logger,
        }
      : { sdkBackend: config.sdkBackend, logger },
  );
  // spec/02 § Model catalogue — live model list for the new-chat picker, read
  // from Anthropic with the same OAuth gate the turn path uses.
  /**
   * The OAuth gate every turn goes through: the host's stored keys, in order,
   * first one with credit (spec/10-auth.md § Backend credentials).
   *
   * A chat does not choose, and cannot: the sequence is the host's, and the same
   * question is asked afresh for every turn. So a key running out is not
   * something each chat discovers by failing on it — one turn learns key 1 is
   * spent, and every turn after that simply runs on key 2, until key 1's limit
   * resets and everything is back on it because it is first in the order.
   *
   * The account it settled on rides back on the result: the turn has to be able
   * to say which key it spent when it fails, and that is the only place that
   * fact exists.
   */
  const resolveOAuthWithCredit = async (turn?: {
    chatId: string;
    preferredAccountId?: string;
    sessionAccountId?: string;
    anyAccount?: boolean;
    check?: boolean;
  }): Promise<OAuthCheckResult> => {
    const store = readPatchStore(oauthOpts);
    if (!store || store.accounts.length === 0) {
      // No store wiring at all (the mock backend in tests): there is no key to
      // name, and inventing one would put a fiction in the usage report.
      return resolveOAuth();
    }
    const { accounts, route } = claudeRoute(
      store,
      turn?.preferredAccountId,
      turn?.sessionAccountId,
      turn?.anyAccount,
    );
    // Read before `startTurn`, which moves a round-robin on.
    const first = accountRotation.order(accounts, route)[0]?.id;
    // Only a starting turn moves the rotation; a credential check peeks.
    const effective =
      turn !== undefined && turn.check !== true
        ? accountRotation.startTurn(accounts, route)
        : accountRotation.effectiveAccount(accounts, route);
    if (effective !== undefined && effective !== first) {
      logger.info(
        {
          first: first ?? null,
          effective,
          strategy: route.strategy,
          sidelined: accountRotation.snapshot(),
        },
        'account routing: the first key has no credit — running this turn on the next one',
      );
    }
    if (effective === undefined) {
      // Nowhere this turn may run. Each case says why, rather than resolving
      // the store's default account, which would run on an account nobody
      // chose — one with `auto` off, at its cap, or not the chat's lock.
      const elsewhere = claudeHeldElsewhere.find((a) => a.id === route.preferred);
      if (route.preferredHeldElsewhere === true && elsewhere !== undefined) {
        return {
          ok: false,
          code: 'account_not_found',
          reason: `This chat is set to ${elsewhere.label}, an Amazon Bedrock account on another host, so it cannot run here. Choose another account for the chat.`,
        };
      }
      const locked = store.accounts.find((a) => a.id === route.preferred);
      const ordered = accountRotation.order(accounts, route);
      // spec/10 § Limits: every account this turn may use is known to have no
      // credit — recorded spent, at a usage reading's limit, or at a Bedrock
      // cap (§ Spending caps). The turn does not start on any of them: it
      // meets the limit without asking a model and pauses until the earliest
      // reset, or stops and asks when none states one.
      const now = Date.now();
      const spent = accountRotation
        .spentInRoute(accounts, route)
        .map((s) =>
          s.capped ? { ...s, kind: 'limit' as const, resetsAt: bedrockCapResetsAt(now) } : s,
        );
      if (spent.length > 0) {
        const soonest = spent
          .filter((s) => s.resetsAt !== undefined)
          .sort((x, y) => x.resetsAt! - y.resetsAt!)[0];
        const blame = soonest ?? spent[0]!;
        const label = store.accounts.find((a) => a.id === blame.accountId)?.label ?? 'An account';
        return {
          ok: false,
          reason: blame.capped
            ? bedrockCapRefusal(label, now)
            : spentRefusal(label, blame.kind, blame.resetsAt),
          limit: {
            accountId: blame.accountId,
            ...(blame.resetsAt !== undefined ? { resetsAt: blame.resetsAt } : {}),
            ...(blame.resetsAt === undefined ? { kind: blame.kind } : {}),
            ...(blame.capped ? { rateLimitType: 'monthly_spending_cap' } : {}),
          },
        };
      }
      // A chat locked to a Bedrock account whose profile is signed out.
      if (locked?.bedrock !== undefined) {
        return {
          ok: false,
          code: 'claude_oauth_missing',
          reason: `${locked.label}: ${bedrockSignIn.error(locked.id) ?? AWS_SIGN_IN_EXPIRED}`,
        };
      }
      // Every account has `auto` off and the chat names none of them.
      if (ordered.length === 0) {
        return {
          ok: false,
          code: 'claude_oauth_missing',
          reason: 'No account is set to switch to automatically',
        };
      }
      // What is left: every account this turn could run on is signed out.
      // Named by the first of them; never the store's default, which may be
      // one nobody chose.
      const first = store.accounts.find((a) => a.id === ordered[0]!.id)!;
      return {
        ok: false,
        code: 'claude_oauth_missing',
        reason:
          first.bedrock !== undefined
            ? `${first.label}: ${bedrockSignIn.error(first.id) ?? AWS_SIGN_IN_EXPIRED}`
            : `${first.label} is signed out. Sign in again in Settings > Usage.`,
      };
    }
    const effectiveAccount =
      effective !== undefined ? store.accounts.find((a) => a.id === effective) : undefined;
    const bedrock = effectiveAccount !== undefined ? bedrockRunOf(effectiveAccount) : undefined;
    if (bedrock !== undefined) {
      return { ok: true, accessToken: '', accountId: bedrock.accountId, bedrock };
    }
    const result = await resolveOAuth(effective);
    return result.ok && effective !== undefined ? { ...result, accountId: effective } : result;
  };

  // One adapter per provider (spec/02 § Provider adapters): what the host does
  // per provider lives here, so the wiring never asks which provider a model
  // belongs to.
  const providerAdapters: ProviderAdapters = {
    claude: {
      // A model on an Anthropic-compatible endpoint runs on Claude Code pointed
      // at that endpoint, with no Claude account (spec/02 § Provider adapters).
      run: (opts) => {
        if (!isEndpointModel(opts.model)) return sdkBackend.run(opts);
        const launch = modelEndpoints.claudeLaunch(opts.model);
        return sdkBackend.run({
          ...opts,
          model: launch.model,
          oauthAccessToken: '',
          modelEndpoint: {
            baseUrl: launch.baseUrl,
            ...(launch.key !== undefined ? { key: launch.key } : {}),
          },
        });
      },
      resolveCredential: async (model, turn) =>
        isEndpointModel(model) ? { ok: true, accessToken: '' } : resolveOAuthWithCredit(turn),
      heldAccounts: () =>
        (readPatchStore(oauthOpts)?.accounts ?? []).map((a) => ({ id: a.id, label: a.label })),
      accountLabel: (accountId) =>
        readPatchStore(oauthOpts)?.accounts.find((a) => a.id === accountId)?.label,
      accountSpent: (fromAccountId) => {
        if (!accountRotation.isExhausted(fromAccountId)) return { spent: false };
        const until = accountRotation.exhaustedUntil(fromAccountId);
        return { spent: true, ...(until !== undefined ? { until } : {}) };
      },
      nextAccountAfterExhausted: (chatId, id, message, limit) =>
        failoverAccount(chatId, id, message, limit),
      accountRouting: () => {
        const store = readPatchStore(oauthOpts);
        if (!store) return undefined;
        const out = store.accounts.filter((a) => accountRotation.isExhausted(a.id));
        const returns = out
          .map((a) => ({ label: a.label, at: accountRotation.exhaustedUntil(a.id) }))
          .filter((r): r is { label: string; at: number } => r.at !== undefined)
          .sort((x, y) => x.at - y.at);
        const next = returns[0];
        return {
          strategy: accountStrategy.claude,
          accounts: store.accounts.length,
          exhausted: out.length,
          ...(next !== undefined
            ? { nextResetsAt: next.at, ...(next.label ? { nextLabel: next.label } : {}) }
            : {}),
        };
      },
      // Claude Code's own settings.json: Settings shows what it holds, so a write is announced.
      ownConfigs: () => [
        {
          label: join(claudeHome, 'settings.json'),
          read: () => readClaudeSettingsJson(claudeHome),
          write: (text) => {
            writeClaudeSettingsJson(claudeHome, text);
            emit({
              type: 'claude_settings.updated',
              hostId: selfHostId,
              ...claudeSettingsSnapshot(),
            });
          },
        },
      ],
    },
    codex: {
      run: (opts) => codexBackend.run(opts),
      resolveCredential: async (model, turn) => {
        // An endpoint model uses no Codex login; an endpoint that is not set
        // up is refused by the turn itself, naming it.
        if (isEndpointModel(model)) return { ok: true, accessToken: '' };
        try {
          const account = await codexAccounts.resolve(
            {
              strategy: accountStrategy.codex,
              ...(turn?.preferredAccountId ? { preferred: turn.preferredAccountId } : {}),
              ...(turn ? { starting: true } : {}),
            },
            true,
            providerAccountKind(providerForBackendId(CODEX_BACKEND_ID), model),
          );
          return { ok: true, accessToken: '', accountId: account.accountId };
        } catch (error) {
          return { ok: false, reason: (error as Error).message };
        }
      },
      heldAccounts: () =>
        (codexAccounts.report().accounts ?? []).map((a) => ({ id: a.id, label: a.label })),
      accountLabel: (accountId) =>
        codexAccounts.report().accounts?.find((a) => a.id === accountId)?.label,
      accountSpent: (fromAccountId) => {
        const info = codexAccounts.limitInfo(fromAccountId);
        const spent = info?.scope !== undefined;
        return {
          spent,
          ...(spent && info?.resetsAt !== undefined ? { until: info.resetsAt } : {}),
        };
      },
      nextAccountAfterExhausted: (_chatId, id) => codexAccounts.markExhausted(id),
      accountRouting: () => undefined,
      // Each CODEX_HOME's config.toml: every account's, and the endpoints'.
      ownConfigs: () =>
        codexAccounts.homes().map((home) => ownConfigFile(join(home, 'config.toml'))),
    },
    // An ACP agent's credential is its provider key or its own sign-in, which
    // only the agent can judge: a turn is refused here only for an agent that
    // is not installed, or one the agent itself last said was signed out.
    acp: {
      run: (opts) => acpBackend.run(opts),
      resolveCredential: async (model, turn) => {
        const agentId = parseAcpModel(model)?.agentId;
        const agent = agentId !== undefined ? acpRegistry.agent(agentId) : undefined;
        if (!agent)
          return {
            ok: false,
            reason: `${model ?? 'This model'} is not an ACP agent this account has.`,
          };
        if (!acpRegistry.command(agent))
          return { ok: false, reason: `${agent.label} is not installed on this host.` };
        // An agent with accounts runs on one (the API key is the default); one
        // without runs on its own sign-in on this host, which is an account of
        // this host's alone, or on a provider key.
        const account =
          agent.apiKeyEnv !== undefined
            ? acpAccounts.resolve(agent.id, acpRoute(turn?.preferredAccountId), turn !== undefined)
            : undefined;
        const accountId = account?.id ?? acpAccounts.hostLogin(agent.id)?.id;
        return { ok: true, accessToken: '', ...(accountId ? { accountId } : {}) };
      },
      // A chat on an agent runs on, and can be locked to, that agent's accounts only.
      heldAccounts: (model) => {
        const agentId = parseAcpModel(model)?.agentId;
        return agentId !== undefined
          ? acpAccounts.forAgent(agentId).map((x) => ({ id: x.id, label: x.label }))
          : [];
      },
      accountLabel: (accountId) =>
        acpAccounts.get(accountId)?.label ??
        acpRegistry
          .agents()
          .map((a) => acpAccounts.hostLogin(a.id))
          .find((l) => l?.id === accountId)?.label,
      accountSpent: (accountId) => ({ spent: acpAccounts.isSkipped(accountId) }),
      // The agent refused this account with a limit: the turn runs again on the
      // next of the agent's accounts that has not been refused, if any.
      nextAccountAfterExhausted: (chatId, id, message) =>
        id !== undefined
          ? acpAccounts.markLimited(
              id,
              message,
              acpRoute(daemon.chatState.get(chatId)?.preferredAccountId),
            )
          : undefined,
      accountRouting: () => undefined,
      // An ACP agent's own files are its own (`AcpAgentConfig.ownSettings`).
      ownConfigs: () => [],
    },
  };

  /**
   * Model-aware credential gate (spec/10-auth.md § Backend credentials): a
   * Codex-prefixed model resolves against the Codex account store, everything
   * else against `resolveOAuthWithCredit`'s rotation — the same split the
   * real chat-turn path and `hook.check_request`'s prompt-hook check use, so a
   * one-shot (a goal evaluation, a prompt hook) never borrows a different
   * provider's credential than the chat it is judging actually runs on.
   */
  const resolveModelOAuth = async (
    model?: string,
    turn?: TurnAccountHint,
  ): Promise<OAuthCheckResult> => {
    return adapterForModel(providerAdapters, model).resolveCredential(model, turn);
  };

  /**
   * The gate EVERY one-shot AI call goes through (spec/10-auth.md § Backend
   * credentials — multiple accounts): walk the stored keys in priority order
   * and run on the first that actually completes the call.
   *
   * A turn learns an account is spent by failing on it, and the next turn is
   * routed elsewhere by `resolveOAuthWithCredit`. A one-shot has no next turn.
   * Resolving once and giving up left title and status generation pinned to a
   * spent account for a whole night — 76 chats came out of it with no status at
   * all — while chats either side of them ran normally on the second account.
   * So a one-shot walks the list itself, and marks what it learns on the way so
   * the calls behind it skip the spent key rather than each rediscovering it.
   *
   * Only an ACCOUNT-EXHAUSTED failure moves to the next key. Anything else —
   * a timeout, a malformed reply, the SDK falling over — would fail the same
   * way on every account, and retrying it across all of them turns one failed
   * call into N.
   */
  const claudeOneShot: ClaudeOneShotDeps = {
    accounts: () => {
      const store = readPatchStore(oauthOpts);
      return store ? store.accounts : null;
    },
    rotation: accountRotation,
    route: (preferred) => {
      const store = readPatchStore(oauthOpts) ?? { accounts: [], activeAccountId: null };
      return claudeRoute(store, preferred);
    },
    resolveOAuth: (accountId) => resolveOAuth(accountId),
    probeBlocked: (accountId) =>
      rejectedRateLimitScope(accountUsage?.get(accountId)?.reading.windows) !== undefined,
    onMarked: () => emit(buildAccountReport()),
    logger,
  };
  const runOnAccountWithCredit: RunOnAccountWithCredit = (label, run) =>
    runClaudeOneShot(claudeOneShot, label, run);
  /**
   * Chat titles and status summaries (spec/10 § Choosing an account): on the
   * account the shared `backgroundAccount` names, or the way any one-shot
   * chooses when it is `auto`. Naming one is how such a call runs on an
   * account with `auto` off.
   */
  const runOnBackgroundAccount: RunOnAccountWithCredit = (label, run) =>
    runClaudeOneShot(
      claudeOneShot,
      label,
      run,
      backgroundAccount === BACKGROUND_ACCOUNT_AUTO ? undefined : backgroundAccount,
    );

  /**
   * For calls that spend no credit — the model catalogue is an auth-only
   * `GET /v1/models`. The credit gate above would refuse them whenever every
   * account is sidelined by a usage limit, which emptied the Claude half of the
   * model picker exactly when someone opens it to pick another model. Here
   * every connected account is tried in stored order, sidelining ignored, and
   * the first that answers wins. A failure on one (revoked token, 5xx) moves to
   * the next; if none answers the last error is thrown, so nothing is hidden.
   * Null only when no account holds a usable credential.
   */
  const runOnAnyAccount: RunOnAccountWithCredit = async <T>(
    label: string,
    run: (accessToken: string) => Promise<T>,
  ): Promise<T | null> => {
    const store = readPatchStore(oauthOpts);
    const ids: Array<string | undefined> =
      store && store.accounts.length > 0
        ? store.accounts.filter((a) => a.credential !== null).map((a) => a.id)
        : [undefined];
    let lastError: unknown;
    for (const accountId of ids) {
      const resolved = await resolveOAuth(accountId);
      if (!resolved.ok) {
        logger.warn({ label, accountId, reason: resolved.reason }, 'ai call: no usable credential');
        continue;
      }
      try {
        return await run(resolved.accessToken);
      } catch (err) {
        lastError = err;
        logger.warn({ label, accountId, err }, 'ungated call failed on this account');
      }
    }
    if (lastError !== undefined) throw lastError;
    return null;
  };

  /**
   * Every stored account's usage, kept current whether or not it can run a
   * turn (spec/10 § Surface in Settings — Usage).
   *
   * Started here rather than at boot because it needs `resolveOAuth` to get a
   * token per account and `emit` to publish what it finds.
   */
  accountUsage = new AccountUsageTracker({
    // Never a Bedrock account: its probe would be a paid call (spec/10 § Usage).
    accounts: () => (readPatchStore(oauthOpts)?.accounts ?? []).filter((a) => !a.bedrock),
    tokenFor: async (accountId) => {
      const resolved = await resolveOAuth(accountId);
      return resolved.ok ? resolved.accessToken : undefined;
    },
    onChange: () => emit(buildAccountReport()),
    // A reading is one of the three events that can restart work stalled on
    // credit — and the only one that covers an account sidelined with no stated
    // reset, which arms no timer. `observedUsable` does the deciding: it
    // resumes nothing for an account nobody was waiting on, and it will not
    // take a reading over a turn that was refused seconds ago.
    onReading: (accountId, reading) => {
      const { session, week } = reading.windows;
      usageHistory.append({
        ts: reading.at,
        accountId,
        label:
          readPatchStore(oauthOpts)?.accounts.find((a) => a.id === accountId)?.label ?? accountId,
        ...(session?.utilization !== undefined ? { session: session.utilization } : {}),
        ...(week?.utilization !== undefined ? { week: week.utilization } : {}),
        ...(session?.resetsAt !== undefined ? { sessionResetsAt: session.resetsAt } : {}),
        ...(week?.resetsAt !== undefined ? { weekResetsAt: week.resetsAt } : {}),
      });
      if (reading.blocked) return;
      creditResume.observedUsable(accountId, reading.at);
    },
    rememberOrganization: (accountId, organizationId) => {
      if (!setAccountOrganization(accountId, organizationId, oauthOpts)) return;
      logger.info(
        { accountId, organizationId },
        'recorded which Claude account this key belongs to',
      );
      // The answer to "is there anywhere to fail over to" may have just
      // changed — two rows can now be seen to be one account.
      emit(buildAccountReport());
    },
    logger,
  });
  // The mock backend has no real credential to probe and no Anthropic to ask;
  // polling it would spend a request per account per ten minutes to learn
  // nothing, and would make every test that boots a host hit the network.
  if (config.sdkBackend === 'real') accountUsage.start();

  const modelCatalog = new ModelCatalog({
    // Not the credit gate: listing models costs nothing, so a usage-limited
    // account must not empty the picker.
    runOnAccountWithCredit: runOnAnyAccount,
    // The Manager's model is refused while there is no catalogue (no AI
    // connected yet); the first real read after a sign-in puts it on it.
    onRefreshed: () => applySpecialThreadModel(),
  });
  // spec/08 § Recurrence — the job editor's natural-language schedule input.
  // Cheap one-shot Haiku, same gate as the title/status/digest generators.
  const translateRecurrenceRule = makeRecurrenceTranslator({
    sdkBackend,
    runOnAccountWithCredit,
    smallJobModels: () => smallJobModels,
    logger,
  });
  // spec/14 § Message links — the Summarise button's one-shot.
  const summariseLink = makeLinkSummariser({
    sdkBackend,
    runOnAccountWithCredit,
    smallJobModels: () => smallJobModels,
  });
  let pullQueuedFromServer: ((chatId: string) => Promise<ChatInputEvent[]>) | undefined;
  const strayProcesses = new StrayProcessTracker();
  const daemon: Daemon = new Daemon({
    ...(durableTurns ? { durableTurns } : {}),
    pullQueued: (chatId) => pullQueuedFromServer?.(chatId) ?? Promise.resolve([]),
    hostId: selfHostId,
    hostName: () => hostName,
    // spec/04 § Spawn — a spawn naming no model takes THIS host's last-used
    // model, and every spawn that names one sets it.
    defaultModel: () => defaultModel,
    agentDefaultModel: () => agentDefaultModel,
    // spec/04 § Model — a mid-chat model change is checked against the model
    // list THIS host actually offers, so an id it cannot run is refused
    // naming it rather than handed to the backend to fail obscurely later. The
    // catalogue is cached (6h TTL), so this is a memory read in the normal case.
    knownModelIds: async () => {
      const results = await Promise.allSettled([
        modelCatalog.get().then((r) => r.models),
        codexAccounts.models(),
        ...modelEndpoints.list().map((e) => modelEndpoints.models(e)),
        acpRegistry.models().then((r) => r.models),
      ]);
      const models = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      if (!models.length)
        throw new Error(
          results.map((r) => (r.status === 'rejected' ? String(r.reason) : '')).join('; '),
        );
      return new Set(models.map((m) => m.id));
    },
    // This host's DEFAULT permission mode, as last set from a surface
    // (`host.settings`). Persisted, so the setting is not silently undone by a
    // restart.
    ...(persistedHostState.permissionModeDefault !== undefined
      ? { permissionModeDefault: persistedHostState.permissionModeDefault }
      : {}),
    metaStore,
    sdkBackend: routedBackend,
    sdkBackendKind: config.sdkBackend,
    // Whether a chat's provider session can still be resumed, asked of the
    // chat's own provider. Claude's probe looks at the SAME root the SDK backend
    // writes to (real: ~/.claude/projects; mock: an isolated per-home dir).
    // Where Claude Code keeps sessions shared across chats: the SAME root the
    // SDK backend writes to (real: ~/.claude/projects; mock: per-home dir).
    sessionStoreRoot: config.claudeProjectsRoot,
    // The user's own MCP servers for a folder, from Claude Code's config,
    // shared into every chat's turns whatever its provider.
    discoverMcpServers: discoverClaudeMcpServers,
    sessionProbe: (() => {
      const probes: Record<ProviderId, SessionProbe> = {
        claude: createClaudeSessionProbe({ claudeProjectsRoot: config.claudeProjectsRoot }),
        codex: codexSessions,
        acp: agentHeldSession,
      };
      // A chat on the retired local-model loop keeps the session it had, so
      // host cleanup never takes it for lost; it cannot run another turn.
      const retiredLocal: SessionProbe = {
        hasSession: ({ sessionId }) =>
          existsSync(join(retiredLocalHistoryDir(config.patchHome), `${sessionId}.jsonl`)),
      };
      return {
        hasSession: (o) =>
          (isRetiredLocalSessionId(o.sessionId)
            ? retiredLocal
            : probes[providerForSessionId(o.sessionId)!]
          ).hasSession(o),
      };
    })(),
    // OAuth gate (spec/10-auth.md): the gate protects the real SDK path only;
    // under SDK_BACKEND=mock it is a no-op so local-dev / the test stack can
    // exercise agent behaviour without a real `claude login`.
    // Routed through the account that has credit, so a spent account is not
    // something every chat has to discover by failing on it.
    resolveOAuth: resolveModelOAuth,
    // The ONE turn that discovers the exhaustion still has to be re-run; from
    // then on `resolveOAuthWithCredit` routes the rest without any of them
    // failing (spec/10-auth.md § Backend credentials).
    accountLabel: (model, accountId) =>
      adapterForModel(providerAdapters, model).accountLabel(accountId),
    accountSpent: (model, fromAccountId) =>
      adapterForModel(providerAdapters, model).accountSpent(fromAccountId),
    nextAccountAfterExhausted: (chatId, id, message, limit) =>
      adapterForModel(
        providerAdapters,
        daemon.chatState.get(chatId)?.model,
      ).nextAccountAfterExhausted(chatId, id, message, limit),
    /**
     * Has this host nowhere to run a turn — every stored key recorded spent?
     *
     * The same question `failoverAccount` asks when it has a failure in hand
     * (`usableAccount` naming nobody), asked without one. A host with no store
     * at all cannot tell, and answers `false`: there is no account for anything
     * to be out of credit ON, so nothing should behave as though there were.
     */
    hostOutOfCredit: (chatId) => {
      const store = readPatchStore(oauthOpts);
      if (!store) return false;
      // A chat locked to an account has nowhere else to go: for it the host is
      // out of credit when ITS account is.
      const { accounts, route } = claudeRoute(
        store,
        chatId === undefined ? undefined : daemon.chatState.get(chatId)?.preferredAccountId,
        undefined,
        chatId === undefined ? undefined : daemon.runsOnAnyAccount(chatId),
      );
      return accountRotation.usableAccount(accounts, route) === undefined;
    },
    // The strategy and how many held keys are out, so a blocked chat says
    // "Round robin — all 3 accounts out" and not just one account's countdown.
    accountRouting: (model) => adapterForModel(providerAdapters, model).accountRouting(),
    /**
     * What is actually true of the account a blocked turn ran on, so the chat
     * can say which pool refused rather than replaying Anthropic's sentence.
     *
     * Reads the probe first and the store second. Both can be absent — a host
     * with no store, a probe that has not landed — and absent is reported as
     * absent: `scope: 'unknown'` is a truthful thing for a surface to render,
     * an invented "session" is not.
     */
    accountLimitInfo: (accountId) => {
      if (accountId === undefined) return undefined;
      const codexLimit = codexAccounts.limitInfo(accountId);
      if (codexLimit) return codexLimit;
      const store = readPatchStore(oauthOpts);
      const account = store?.accounts.find((a) => a.id === accountId);
      const entry = accountUsage?.get(accountId);
      const windows = entry?.reading.windows;
      // The pool that RAN OUT — one a person actually spends. Overage is
      // deliberately not a candidate: it is the overflow that covers for these
      // two, so naming it as the limit hit produces a headline nobody can act
      // on. "Extra usage limit on Default" was that headline. Its state
      // travels separately, because it has a different remedy: the session
      // limit resets on its own, extra usage being off does not.
      const refusing = refusingRateLimitScope(windows);
      const window = refusing ? windows?.[refusing] : undefined;
      const estimated = refusing !== undefined && rejectedRateLimitScope(windows) === undefined;
      const overage = windows?.overage;
      return {
        ...(account?.label !== undefined ? { label: account.label } : {}),
        ...(refusing !== undefined ? { scope: refusing } : {}),
        ...(estimated ? { estimated: true as const } : {}),
        ...(window?.utilization !== undefined ? { utilization: window.utilization } : {}),
        ...(window?.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
        ...(overage?.status === 'rejected' ? { overageBlocked: true } : {}),
        ...(overage?.disabledReason !== undefined ? { overageReason: overage.disabledReason } : {}),
      };
    },
    // spec/04 § Name: summarise each chat's opening exchange into a short title
    // once, after the first response — a cheap one-shot Haiku call. Fired async
    // + non-blocking inside the host; a failure leaves the chat unnamed.
    generateTitle: makeTitleGenerator({
      sdkBackend,
      // On the shared `backgroundAccount` (spec/10 § Choosing an account).
      runOnAccountWithCredit: runOnBackgroundAccount,
      smallJobModels: () => smallJobModels,
      // A Codex chat is titled on its own model, like its goal check (below).
      codex: { sdkBackend: routedBackend, resolveOAuth: resolveModelOAuth },
      endpoint: { sdkBackend: routedBackend, resolveOAuth: resolveModelOAuth },
      logger,
    }),
    // patch/todo.md § Features to add — "Current status": after each turn
    // settles, summarise the thread's current status + whether it's paused on a
    // user question or merely complete. Cheap one-shot Haiku, fired async +
    // non-blocking; a failure leaves the previous status unchanged.
    generateStatus: makeStatusGenerator({
      sdkBackend,
      runOnAccountWithCredit: runOnBackgroundAccount,
      smallJobModels: () => smallJobModels,
      logger,
    }),
    // spec/04 § Goals: after each turn settles on a chat with an active goal,
    // judge the condition against the transcript so far. `routedBackend` +
    // `resolveModelOAuth` (same pair `hook.check_request`'s prompt check uses)
    // so a Codex chat's goal is judged on ITS OWN model, not borrowed Haiku.
    evaluateGoal: makeGoalEvaluator({
      sdkBackend: routedBackend,
      resolveOAuth: resolveModelOAuth,
      settings: () => ({ prompt: goalEvalPrompt, model: goalModel, stringency: goalStringency }),
      logger,
    }),
    // spec/14 § Tool runs: label each closed run of tool calls with what it was
    // for ("Set up the project locally"). Cheap one-shot Haiku, async; a
    // failure is stamped on the run rather than hidden.
    summarizeToolRun: makeToolRunSummarizer({
      sdkBackend,
      runOnAccountWithCredit,
      smallJobModels: () => smallJobModels,
      logger,
    }),
    // spec/04 § Send back — the one-line summary a side branch's conclusion
    // carries into its parent track. Cheap one-shot Haiku, async.
    summarizeBranchSendBack: makeBranchSendBackSummarizer({
      sdkBackend,
      runOnAccountWithCredit,
      smallJobModels: () => smallJobModels,
      logger,
    }),
    // spec/06 § Session rotation — the handoff digest a scheduled rotation
    // asks the outgoing special-thread session to write for itself before
    // it's retired.
    // spec/06 § Finished chats — a finished chat on another host is read
    // through the same relay `patch_peek` uses.
    peekRemoteChat: peekFromServer,
    emit,
    // A side branch's entries go to the server's record only: never through the
    // observers above, and only to a server that keeps branches (spec/04 §
    // Parallel branches).
    recordOnly: (event) => {
      if (link.keepsBranches()) link.send(event);
    },
    logger,
    mcpServer: {
      command: mcpBin.command,
      args: mcpBin.args,
      env: {
        PATCH_HOST_SOCKET: config.socketPath,
        PATCH_DAEMON_SOCKET: config.socketPath,
        // The child presents this as a Bearer on every socket call (spec/02
        // § MCP server). It is handed over in the environment the host sets,
        // which is also how the host knows the child is one it started —
        // identity is plumbing, not the key.
        PATCH_DAEMON_LOCAL_KEY: localKey,
        // The child outlives a host restart (which rotates the key), so it
        // re-reads the current key from here on every call.
        PATCH_DAEMON_LOCAL_KEY_FILE: localKeyPath(config.patchHome),
        // PATCH_CHAT_ID is injected per-query in chatRunner.runQuery —
        // the MCP child needs the *current* chatId, not a static one.
        // See group 10 BLOCKER A.2.
      },
    },
    // Group 11: prepend the broadcast note for special threads.
    preprocessInput: (req) => {
      // Meeting mode: the panel and any transcript the model has not seen ride in
      // front of the user's turn as a note, its own entry in the record.
      const meetingBlock = meetings?.contextFor(req.chatId);
      if (meetingBlock !== undefined) {
        return meetingBlock + (req.voicePrefix ? `${req.voicePrefix}${req.message}` : req.message);
      }
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(req.chatId)) return undefined;
      const threadId = req.chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return undefined;
      const entries = readPendingBroadcasts(hostCwd, threadId);
      const now = Date.now();
      const block = buildBroadcastNote(entries, now);
      if (!block) return undefined;
      return block + (req.voicePrefix ? `${req.voicePrefix}${req.message}` : req.message);
    },
    sleepGuard: createSleepGuard({ logger }),
    holdTurns: () => memoryCritical,
    sleepWatch: createSleepWatch({
      logger,
      // Whatever the server link held across the gap is stale: re-handshake now
      // rather than waiting for a heartbeat to notice, so fires held for this
      // host are released as soon as it is running again.
      onGap: () => {
        link.dropLink();
      },
    }),
    onDrawnTurnStarted: (chatId, localId) => {
      voiceReplies.turnStarted(chatId, localId);
      chatVoice.handoffStarted({ chatId, handoffId: localId });
    },
    onTurnCommitted: (chatId) => {
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(chatId)) return;
      const threadId = chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return;
      flushBroadcasts(hostCwd, threadId);
    },
    // patch/todo.md § Features to add — "todo list": mirror each chat's native
    // TodoWrite list onto chat state and, when a turn settles with items still
    // pending, fire the next one back as a fresh `[todo]` turn so the agent works
    // its list one focused item at a time instead of getting distracted.
    autoAdvanceTodos: true,
    // spec/20-hooks.md § On the agent's response — check `agent_response`
    // hooks after every turn settles.
    checkAgentResponseHooks: true,
    // spec/06 § Bounded context — persisted global preference.
    managerContextWindow,
    // spec/16 § Speaking aloud — a turn heard on a voice device is answered in a room.
    voiceDevicePrompt: () => voiceDevicePrompt,
    onRateLimit: reportUsage,
    onTurnEnd: (_chatId, accountId) => {
      if (accountId !== undefined) void accountUsage?.refreshAfterTurn(accountId);
    },
    // Computer use is off until granted; Always allow persists to host.json.
    computerUse: {
      alwaysAllowed: () => hostStateStore.get().computerUseAlwaysAllowed === true,
      setAlwaysAllowed: () => hostStateStore.update({ computerUseAlwaysAllowed: true }),
    },
    // spec/02 § Browser — In the Patch app: when the app is installed on this
    // host, the agent's browser lives in it.
    appBrowser: appBrowserLink({
      home: homedir(),
      logger: logger.child({ component: 'app-browser' }),
    }),
    // Initialized from persisted state; toggled by `host.settings`.
    // Not passed here — `setLimitBehaviour` is called after construction.
    // spec/10 § Backend credentials — multiple accounts: validates/resolves a
    // spawn's `accountId` against what this host actually has stored. Reads
    // the store fresh each call (not cached) so an account added/removed
    // between spawns is reflected immediately.
  });
  recordImport = new RecordImport({
    path: join(config.patchHome, 'record-import.json'),
    logger,
    // A subagent's chats are never on the wire, so not in the server's record.
    listChats: () =>
      daemon
        .list()
        .map((c) => c.chatId)
        .filter((id) => !daemon.isSubagent(id)),
    recordOf: (chatId) => {
      try {
        return daemon.recordForImport(chatId);
      } catch (err) {
        if (err instanceof ChatNotFoundError) return null;
        throw err;
      }
    },
    send: (event) => link.send(event),
  });
  delegateRecordImport = new RecordImport({
    path: join(config.patchHome, 'delegate-record-import.json'),
    logger,
    // Every subagent on the host, loaded or not: one that finished long ago
    // still needs its transcript readable from the server. Read from metas,
    // so listing them loads none.
    listChats: () => daemon.subagentIds(),
    // Read from disk without loading the subagent (spec/02 § Chat loading).
    recordOf: (chatId) => {
      try {
        return daemon.delegateRecordForImport(chatId);
      } catch (err) {
        if (err instanceof ChatNotFoundError) return null;
        throw err;
      }
    },
    parentOf: (chatId) => daemon.delegateParentOf(chatId),
    // Paced, so a few hundred old subagents do not land in one burst at startup.
    pauseMs: 250,
    send: (event) => link.send(event),
  });
  daemon.setWatchCheckIn({ intervalMs: watchCheckInMinutes * 60_000, prompt: watchCheckInPrompt });
  // Meeting mode (meeting.ts). Local Whisper unless the account's meeting engine
  // setting (Settings → Dictation) picks a paid one: a meeting is hours of audio, so a
  // paid STT backend is never picked just because a key exists.
  // Starts (or re-tries, at most once a minute after a failure) the Whisper
  // component download and returns the notice a meeting clip shows meanwhile.
  let lastSpeechModelTry = 0;
  const preparingSpeechModel = (): MeetingNotice => {
    const c = components.describe().find((x) => x.id === 'whisper');
    if (c?.state === 'downloading') {
      return new MeetingNotice(
        `Setting up speech recognition on this machine (${Math.round((c.progress ?? 0) * 100)}%). Transcription starts when it is ready.`,
      );
    }
    if (c?.state === 'failed' && Date.now() - lastSpeechModelTry < 60_000) {
      return new MeetingNotice(
        `Speech recognition could not be set up on this machine: ${c.error ?? 'unknown error'}. Retrying shortly.`,
      );
    }
    lastSpeechModelTry = Date.now();
    components.install('whisper');
    return new MeetingNotice(
      'Setting up speech recognition on this machine. Transcription starts when it is ready.',
    );
  };
  const scribeVoiceMaps = new Map<string, ScribeVoiceMap>();
  // One Vad for the meeting gate, built lazily from the audio stack's factory
  // (`makeVad`, defined once the audio server starts). Clips run one at a time.
  let gateVad: Vad | undefined;
  const meetingVad = (): Vad => (gateVad ??= makeVad());
  const deepgramMeeting = new DeepgramMeetingBackend({
    logger: logger.child({ component: 'meeting-stt' }),
    apiKey: () => providerKeys.get('deepgram'),
  });
  const assemblyaiMeeting = new AssemblyAiMeetingBackend({
    logger: logger.child({ component: 'meeting-stt' }),
    apiKey: () => providerKeys.get('assemblyai'),
  });
  meetings = new MeetingManager({
    dir: join(config.patchHome, 'meetings'),
    // Drop call clips with no speech before they reach the STT engine.
    hasSpeech: async (wav) => clipHasSpeech(wav, meetingVad(), DEFAULT_VAD_CONFIG.startTh),
    transcribe: async (wav) => {
      if (!dictationTranscribers)
        throw new Error('host audio stack not ready — whisper unavailable');
      // A meeting needs no setup: on a machine with no speech model and no
      // engine chosen, the first clip fetches the model. Until it lands each
      // clip says so (it is not transcribed — never a made-up transcript).
      if (whisper instanceof UnconfiguredWhisperBackend && config.audio.speechAuto) {
        throw preparingSpeechModel();
      }
      return dictationTranscribers.local.transcribeClip(wav, 'wav');
    },
    // Who transcribes a meeting is the account's `voiceConfig.meeting` setting,
    // read per clip. `local` separates voices with the local sidecar's speaker
    // model when DIARISE_MODEL_PATH is set; a hosted engine (ElevenLabs, Deepgram,
    // AssemblyAI) does its own diarisation. Chosen explicitly, never as a
    // fallback: a missing key or a failed request fails the clip. Usage goes on
    // the voice ledger.
    transcribeVoicesFor: (chosen) => {
      const engine = chosen ?? voiceConfig.meeting;
      if (engine === 'local') {
        if (!process.env['DIARISE_MODEL_PATH']) return undefined;
        return async (session: string, wav: Buffer) => {
          if (!(whisper instanceof LocalWhisperBackend))
            throw new Error('DIARISE_MODEL_PATH is set but the speech engine is not local');
          return whisper.transcribeVoices(session, wav);
        };
      }
      return async (session: string, wav: Buffer) => {
        const hosted: DiarisedClipEngine | undefined =
          engine === 'elevenlabs'
            ? dictationTranscribers?.elevenlabs instanceof ElevenLabsScribeBackend
              ? dictationTranscribers.elevenlabs
              : undefined
            : engine === 'deepgram'
              ? providerKeys.has('deepgram')
                ? deepgramMeeting
                : undefined
              : providerKeys.has('assemblyai')
                ? assemblyaiMeeting
                : undefined;
        if (!hosted) throw new Error(voiceKeyMissingMessage('meeting', engine));
        const startedAt = Date.now();
        const runs = await hosted.transcribeDiarised(wav);
        const audioSeconds = Math.max(0, wav.length - 44) / 32000;
        const sep = session.lastIndexOf(':');
        voiceLedger.record(
          costCall({
            sessionId: `meeting-stt-${startedAt}`,
            chatId: session.slice(0, sep),
            surfaceKind: 'meeting',
            startedAt,
            endedAt: Date.now(),
            engine: {
              backend: 'local',
              model: hosted.costModel,
              tokens: null,
              stt: { requests: 1, audioSeconds, billedSeconds: audioSeconds },
            },
            handoffs: 0,
          }),
        );
        let map = scribeVoiceMaps.get(session);
        if (!map) scribeVoiceMaps.set(session, (map = new ScribeVoiceMap()));
        return map.assign(runs);
      };
    },
    ...(process.env['VOICEPRINT_PATH']
      ? { hasVoiceprint: () => existsSync(process.env['VOICEPRINT_PATH'] as string) }
      : {}),
    analyse: makeMeetingAnalyser({
      sdkBackend,
      runOnAccountWithCredit,
      cwd: hostCwd,
      model: () => meetingModels.analysis,
      onDropped: (chatId, msg) => logger.warn({ chatId }, `meeting: ${msg}`),
    }),
    correct: makeMeetingCorrector({
      sdkBackend,
      runOnAccountWithCredit,
      cwd: hostCwd,
      model: () => meetingModels.cleanup,
    }),
    writeup: makeMeetingWriteup({
      sdkBackend,
      runOnAccountWithCredit,
      cwd: hostCwd,
      model: () => meetingModels.analysis,
    }),
    research: makeMeetingResearcher({
      sdkBackend,
      runOnAccountWithCredit,
      cwd: hostCwd,
      model: () => meetingModels.research,
    }),
    researchSeconds: () => meetingResearchSeconds,
    // Optional user glossary: <patchHome>/meetings/glossary.txt, one term per line.
    glossary: () => {
      const f = join(config.patchHome, 'meetings', 'glossary.txt');
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    },
    prompts: () => meetingPrompts,
    emit,
    startChat: async (parentChatId, message) => {
      const parent = daemon.chatState.get(parentChatId);
      if (!parent) throw new Error(`meeting chat ${parentChatId} is not on this host`);
      return daemon.spawnChat({
        folder: parent.folder,
        prompt: message,
        ...(parent.model !== undefined ? { model: parent.model } : {}),
        permissionMode: parent.permissionMode,
      });
    },
    nameChat: (chatId, title) => daemon.setName(chatId, title),
    logger: logger.child({ component: 'meeting' }),
  });
  // Apply persisted auto-resume setting before hydrate so any in-flight chats
  // restored from disk get the right setting immediately.
  daemon.setTitleGenerationEnabled(titleGenerationEnabled);
  daemon.setStatusGenerationEnabled(statusGenerationEnabled);
  daemon.setLimitBehaviour(limitBehaviour);
  daemon.setQuestionExpiry({
    enabled: questionExpiry,
    seconds: questionExpirySeconds,
    expiredPrompt: questionExpiredPrompt,
  });
  daemon.setGoalRefusalLimit(goalRefusalLimit);
  // Apply persisted harness config (Task 3; spec/14 § Agent behavior) before hydrate.
  applyHarnessConfig();
  daemon.hydrate({ deferWorkUntilReconciled: true });
  // spec/04 § Folders: the host owns the folder registry. Its list is the
  // registered project roots first, then folders seen in recent chats. It
  // publishes `folders.list` on connect (onAuthed, above) and `folders.updated`
  // whenever the set changes (via `emit` on chat.spawned) over the server link.
  folderRegistry = new FolderRegistry({
    // Designated project roots survive a restart (`host.folder_add` is a user
    // designation, not a cache).
    registered: persistedHostState.folderRoots ?? [],
    source: {
      // The loaded chats, then the folders last published for chats that are
      // not loaded (spec/02 § Chat loading). A host with none published yet
      // reads every chat's meta once.
      listChats: () => {
        const loaded = daemon.list().map((c) => ({
          chatId: c.chatId,
          folder: c.folder,
          lastUpdated: c.lastUpdated,
        }));
        const kept = hostStateStore.get().recentFolders;
        if (kept === undefined) {
          return daemon.listAll().map((c) => ({
            chatId: c.chatId,
            folder: c.folder,
            lastUpdated: c.lastUpdated,
          }));
        }
        return [
          ...loaded,
          ...kept.map((folder, i) => ({ chatId: `kept-${i}`, folder, lastUpdated: -i - 1 })),
        ];
      },
    },
    onChange: (registry) => {
      hostStateStore.update({ recentFolders: registry.recent.slice(0, 50) });
      link.send({ type: 'folders.updated', hostId: selfHostId, ...registry });
    },
  });
  // The Manager and Speakers are the account's and live on the host the server has running them
  // (spec/06 § Where special threads run), so only that host creates them.
  function createSpecialThreads(): void {
    ensureSpecialThreads({
      patchHome: hostCwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => Date.now(),
      logger,
      permissionModeDefault: daemon.permissionModeDefault(),
    });
    applySpecialThreadModel();
    applyManagerSettings();
  }
  /** The Manager's prompt and folder, onto the Manager chat if this host runs it. */
  function applyManagerSettings(): void {
    // A host that no longer runs the Manager leaves its copy where it was.
    if (!runsManager) return;
    if (managerPrompt !== undefined) daemon.setManagerPrompt(managerPrompt);
    if (managerFolder === undefined) return;
    daemon.setManagerFolder(
      managerFolder === '' ? specialThreadFolder(hostCwd, 'thread_manager') : managerFolder,
    );
  }
  if (runsManager) createSpecialThreads();
  /** Tell the server about one chat: that it exists, and its current state. */
  function announceSpecialThreads(): void {
    for (const id of Object.values(SPECIAL_THREAD_IDS)) {
      const state = daemon.chatState.get(id);
      if (state) announceChat(state);
    }
  }

  function announceChat(state: ReturnType<typeof daemon.list>[number]): void {
    const parentName =
      state.spawnedByChatId !== undefined
        ? daemon.chatState.get(state.spawnedByChatId)?.name
        : undefined;
    forward({
      type: 'chat.spawned',
      chatId: state.chatId,
      hostId: selfHostId,
      folder: state.folder,
      ...(state.spawnedByChatId !== undefined ? { parentChatId: state.spawnedByChatId } : {}),
      ...(parentName ? { parentChatName: parentName } : {}),
    });
    // The full frame, not a hand-picked subset: the server's registry is rebuilt
    // from this replay, and a field left out (model, context, background tasks)
    // is forgotten there until something next changes it.
    const stateEvent = daemon.currentStateEvent(state.chatId);
    if (!stateEvent) throw new Error(`announceChat: no state for chat ${state.chatId}`);
    forward(stateEvent);
  }

  // 5. UDS control HTTP.
  // Group 10 BLOCKER B.8: jobs DATA lives on the SERVER. The host's
  // patch_job_* MCP tools relay through this RemoteJobsStore which
  // round-trips `patch.jobs.request`/`patch.jobs.response` events over the
  // server-daemon WS.
  const jobs = new RemoteJobsStore({
    emit,
    isLinkOnline: () => linkOnline,
  });

  // patch_artifact (spec/14 § Artifacts): the host owns the file, the server
  // owns the public origin — the page round-trips over
  // `patch.artifact.publish_request`/`_response` on the same link.
  const artifactPublisher = new ArtifactPublisher({
    emit,
    isLinkOnline: () => linkOnline,
  });
  artifactAutoRepublisher = new ArtifactAutoRepublisher({
    folderOf: (chatId) => daemon.chatState.get(chatId)?.folder,
    publish: artifactPublisher.publish,
    emitArtifact: (chatId, a) => daemon.emitArtifact(chatId, a),
    logger,
  });
  // patch_pad_* (spec/14 § Pads): the same round trip, for design spaces.
  const padClient = new PadClient({ emit, isLinkOnline: () => linkOnline });
  // The shared accounts, asked of the server over the same link.
  const accountsClient = new AccountsClient({ emit, isLinkOnline: () => linkOnline });
  const serverApiClient = new ServerApiClient({ emit, isLinkOnline: () => linkOnline });
  const serverEventsClient = new ServerEventsClient({ emit, isLinkOnline: () => linkOnline });
  // spec/04 § Message queueing — the server-run queue's tool-boundary pull.
  const queuePull = new QueuePullClient({
    emit,
    isLinkOnline: () => linkOnline,
    // The server's answer came after the pull timed out: it has let go of these
    // messages, so they join the host's own queue like any other message.
    onLate: (chatId, items) => {
      for (const item of items) {
        daemon.sendInput(chatInputToSendOptions(item)).catch((err) => {
          logger.error(
            { chatId, localId: item.localId, err },
            'late queue pull: could not deliver',
          );
        });
      }
    },
  });
  pullQueuedFromServer = (chatId) => queuePull.pull(chatId);

  // Dial OUT to the patch-server WebSocket AS EARLY as boot allows (spec/12
  // ## Surface connection state model: "the host should dial the server as
  // early as startup allows"). Everything the link genuinely needs is now
  // wired: the daemonKey (step 3), config (serverWsUrl), and the graph the
  // onAuthed/onFrame closures touch — `daemon`, `folderRegistry`,
  // `secretsStore`, `jobs`. The remaining startup work (UDS control listen,
  // /healthz, and the heavy voice stack in step 8) is NOT a prerequisite for a
  // healthy link, so we dial before it rather than after — a surface no longer
  // sits in `connecting`/daemon-unknown while the audio models load. Emits
  // raised during the rest of boot buffer in the link's offline buffer and
  // flush the instant `auth.ok` lands. Auto-reconnects with a short first
  // backoff (serverLink BACKOFF_SCHEDULE_MS).
  link.start();
  // spec/02 § Host restarts: script runs a previous host started are picked up
  // and reported when they end; one that died with the machine is reported
  // interrupted.
  try {
    const n = jobRuns.adopt();
    if (n > 0) logger.info({ runs: n }, 'patch-daemon: picked up running script jobs');
  } catch (err) {
    logger.error({ err }, 'patch-daemon: could not pick up running script jobs');
  }
  // spec/02 § Host restarts: terminals a previous host left running are
  // reattached, and what they printed meanwhile goes to the surface.
  terminals.adopt().then(
    (n) => {
      if (n > 0) logger.info({ terminals: n }, 'patch-daemon: reattached terminals');
    },
    (err) => logger.error({ err }, 'patch-daemon: terminal reattach failed'),
  );
  logger.info({ url: config.serverWsUrl }, 'patch-daemon: dialing patch-server WS');

  // POST /stop (control IPC) calls this; assigned once the graceful-shutdown
  // closure is defined below. Until then the endpoint 503s.
  let shutdownHook: (() => void) | undefined;
  // Is a newer build published for this host? Checked on boot and every two
  // minutes, the same cadence the server checks for releases, and installed as
  // soon as it is seen (spec/02 § Installation). The check is one request to
  // this host's own server. A failed check leaves the flag alone and logs why:
  // an unreachable update channel is not evidence that no update exists.
  const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
  // The host's Claude Code CLI is checked against its own installer, an
  // outside download, so it keeps an hourly cadence.
  const CLAUDE_CLI_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  /**
   * Actually try the credential and report what happened. A token that exists
   * but cannot be refreshed is NOT a working credential, and saying otherwise
   * is what let the app look healthy while every turn would fail. Runs on boot
   * and hourly; the spawn gate corrects it immediately on a real failure.
   */
  const refreshCredentialState = async (): Promise<void> => {
    // A host whose only Claude accounts are on Bedrock has no token to resolve:
    // its active account is a profile, connected while it is signed in.
    const store = readPatchStore(oauthOpts);
    const active = store?.accounts.find((a) => a.id === store.activeAccountId);
    const ok =
      active?.bedrock !== undefined
        ? !bedrockSignIn.signedOut(active.id)
        : (await resolveOAuth()).ok;
    if (ok === credentialOk) return;
    credentialOk = ok;
    logger.info({ credentialOk }, 'backend credential state changed');
    emit(buildAccountReport());
    emit(describeHost());
  };
  void refreshCredentialState().catch((err: unknown) => {
    logger.warn({ err }, 'credential check failed');
  });
  const credentialTimer = setInterval(
    () => {
      void refreshCredentialState().catch((err: unknown) => {
        logger.warn({ err }, 'credential check failed');
      });
    },
    60 * 60 * 1000,
  );
  credentialTimer.unref?.();

  const refreshUpdateAvailable = async (): Promise<void> => {
    const check = await checkForUpdate({
      serverUrl: config.serverUrl,
      currentVersion: VERSION,
      target: BUILD_TARGET,
    });
    if (check.available !== updateAvailable) {
      updateAvailable = check.available;
      logger.info(
        { updateAvailable, published: check.version, reason: check.reason },
        'self-update: availability changed',
      );
      // The surface's Hosts list reads this off the self-description.
      emit(describeHost());
    }
    // spec/02 § Installation — "checks the server for a newer build on boot
    // and on a schedule, downloads it, and restarts itself". Reporting
    // `updateAvailable` above is NOT that: without this, a published build
    // sits advertised-but-never-pulled until a human clicks Update in
    // Settings → Hosts, which a host running unattended jobs never gets
    // (2026-09-30 — this host ran over 30h behind a published build with
    // nothing to show for the "schedule" but the Hosts badge). `applyUpdateOnce`
    // already knows how to do this safely: nothing happens with no update
    // published, and turns, watches and terminals outlive the restart
    // (spec/02 § Host restarts), so nothing waits for the host to be idle.
    if (autoUpdateHosts && (check.available || check.awaitingArtifact)) {
      if (check.version && check.version === hostStateStore.get().lastAutoUpdateAttempt) {
        logger.warn(
          { version: check.version },
          'self-update: scheduled apply skipped, this version was already attempted and this host is still not on it; use Update to retry',
        );
        return;
      }
      const result = await applyUpdateOnce();
      if (!result.applied && !result.deferred) {
        logger.warn({ reason: result.message }, 'self-update: scheduled apply refused');
      }
    }
  };
  void refreshUpdateAvailable().catch((err: unknown) => {
    logger.warn({ err }, 'self-update: initial availability check failed');
  });
  sleepDetector.start();
  const updateCheckTimer = setInterval(() => {
    void refreshUpdateAvailable().catch((err: unknown) => {
      logger.warn({ err }, 'self-update: availability check failed');
    });
  }, UPDATE_CHECK_INTERVAL_MS);
  // Never hold the process open for a version check.
  updateCheckTimer.unref?.();

  // The host's Claude Code, checked hourly (spec/02 § Agent backends). The CLI only self-updates from an
  // INTERACTIVE session, and a host that exists to run jobs never has one — so
  // it silently stops moving, and an old enough build starts substituting
  // working-looking alternatives for features it is gated out of (a stale CLI is
  // how `--permission-mode auto` became `default` on every unattended job).
  // Nothing here fails the host: a host with no `claude` at all reports its
  // backend absent through the existing gate, and a failed update is logged
  // with the CLI's own stderr.
  //
  // A host with no `claude` at all installs it with Claude Code's own installer
  // (spec/02 § Agent backends, "Absent"): on a computer with nothing installed
  // this is what makes a Claude chat possible at all. A mock SDK backend runs no
  // Claude Code, so it provisions none.
  const resolveClaude = (): string | undefined =>
    resolveClaudeExecutable({
      home: homedir(),
      pathEnv: process.env['PATH'] ?? '',
      override: process.env['CLAUDE_CODE_PATH'],
    });
  // Installed only when a surface asks (`host.backend_install`), which it does
  // once the user has picked Claude: a host never installs a provider nobody
  // chose. Without a request an absent CLI stays absent and is reported so.
  const installClaudeOnRequest = async (reinstall = false): Promise<void> => {
    if (reinstall && config.sdkBackend !== 'mock') {
      await refreshClaudeCli(true, true);
      return;
    }
    if (resolveClaude() !== undefined) {
      void refreshClaudeCli();
      return;
    }
    await refreshClaudeCli(true);
  };
  // A failed install tries again by itself, on a widening delay, until it works:
  // the usual cause is a network that was down for a minute. A surface's Retry,
  // and a Claude turn that finds no Claude Code, each try at once as well.
  const CLAUDE_RETRY_DELAYS_MS = testHooks?.claudeRetryDelaysMs ?? [
    30_000, 60_000, 120_000, 300_000, 600_000,
  ];
  let claudeRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let claudeAttempts = 0;
  const refreshClaudeCli = async (install = false, force = false): Promise<void> => {
    const executable = resolveClaude();
    if (executable === undefined || force) {
      if (!install || config.sdkBackend === 'mock' || claudeProvision.state === 'installing')
        return;
      if (claudeRetryTimer) clearTimeout(claudeRetryTimer);
      claudeRetryTimer = undefined;
      claudeAttempts += 1;
      claudeProvision = { state: 'installing' };
      emit(describeHost());
      logger.info(
        { attempt: claudeAttempts },
        'claude-install: this host has no Claude Code; installing it',
      );
      const installing = testHooks?.installClaudeCode
        ? testHooks.installClaudeCode(homedir())
        : installClaudeCode({ home: homedir() });
      setClaudeInstallGate(
        installing.then(
          () => undefined,
          () => undefined,
        ),
      );
      const result = await installing.finally(() => setClaudeInstallGate(undefined));
      const installed = result.ok ? resolveClaude() : undefined;
      if (installed === undefined) {
        const cause = result.ok
          ? "Claude Code couldn't be installed on this computer."
          : installFailure(result);
        const delay =
          CLAUDE_RETRY_DELAYS_MS[Math.min(claudeAttempts - 1, CLAUDE_RETRY_DELAYS_MS.length - 1)]!;
        claudeProvision = {
          state: 'failed',
          error: `${cause} Patch will try again automatically.`,
        };
        // The installer's own words belong here, not on a surface.
        logger.error(
          { exitCode: result.exitCode, output: result.output.slice(-4000), retryInMs: delay },
          'claude-install: failed',
        );
        claudeRetryTimer = setTimeout(() => {
          void refreshClaudeCli(true).catch((err: unknown) => {
            logger.warn({ err }, 'claude-install: retry failed');
          });
        }, delay);
        claudeRetryTimer.unref?.();
      } else {
        // The SDK path is resolved once per process; it resolved to nothing.
        forgetClaudeExecutable();
        claudeProvision = { state: 'present' };
        claudeAttempts = 0;
        logger.info({ executable: installed }, 'claude-install: installed');
      }
      emit(describeHost());
      return;
    }
    if (claudeProvision.state !== 'present') {
      forgetClaudeExecutable();
      claudeProvision = { state: 'present' };
      emit(describeHost());
    }
    await updateClaudeCli({ executable, logger });
  };
  // Before a Claude turn: install now if it is missing, and say plainly if it
  // still is. Only a host running Claude turns for real has anything to install.
  setClaudeEnsure(async () => {
    if (config.sdkBackend === 'mock' || resolveClaude() !== undefined) return undefined;
    await refreshClaudeCli(true);
    if (resolveClaude() !== undefined) return undefined;
    return claudeProvision.state === 'failed' && claudeProvision.error
      ? claudeProvision.error
      : "Claude Code couldn't be installed on this computer.";
  });
  void refreshClaudeCli().catch((err: unknown) => {
    logger.warn({ err }, 'claude-cli-update: initial update failed');
  });
  // Work stalled on a spent account, restarted the MOMENT credit returns
  // (spec/10-auth.md § Backend credentials). The sequence itself lives in
  // `creditResume.ts`; what is here is the boot re-arm.
  //
  // Event-driven, not polled. The limit message states when it resets
  // ("resets 8pm (UTC)"), so the reset is a known instant and deserves a timer
  // armed for exactly it — not a clock that wakes every few minutes to ask
  // whether anything has changed. There are three events that can make stalled
  // work runnable again, and every one of them restarts BOTH the parked chats
  // and the errored ones:
  //
  //   1. a limit reaching its stated reset  → `creditResume`'s own timer, armed
  //      when the exhaustion is recorded and re-armed after it fires;
  //   2. a person adding or reconnecting a key → handled at those frames;
  //   3. a usage reading showing an account that was spent is spendable again
  //      → `onReading` below, off the probe the tracker already takes on its
  //      own 10-minute refresh and when a person presses Refresh.
  //
  // (3) exists because an account exhausted with NO stated reset time arms no
  // timer — there is no instant to arm for — and before it, such an account
  // stayed sidelined until someone touched a credential.
  /**
   * Re-arm after a restart, from what is on disk.
   *
   * Exhaustion is in-memory, so a restart forgets which accounts are out and
   * arms nothing — and an event-driven retry with no armed event never fires.
   * The reset time is recoverable though: every chat that failed this way holds
   * the provider's own message in its persisted `lastError`, reset time and all.
   * So the boot re-derives the earliest reset still ahead and arms for it.
   *
   * Without this, a host restart is the one thing that could leave a failed
   * chat waiting forever — exactly the behaviour being fixed.
   */
  const armCreditRetryFromDisk = (): void => {
    const now = Date.now();
    let soonest: number | undefined;
    for (const state of daemon.chatState.list()) {
      // Off META, and with no filter on the lifecycle status. This read used to
      // be `state.status === 'errored'` and then `state.lastError`, and neither
      // is what a limit leaves: a credit park keeps the status `active` (the
      // chat has work owed, it is not dead), and the hydrator only rehydrates a
      // persisted `lastError` for a chat whose stored status says errored. So
      // the one thing that re-arms the retry after a restart — the restart being
      // the only way a park can be lost — was reading a field that was always
      // null by the time it looked.
      const last = metaStore.read(state.chatId)?.lastError ?? state.lastError;
      if (!last || last.outOfCredit !== true) continue;
      const at = parseLimitResetsAt(last.message, last.at);
      if (at === undefined || at <= now) continue;
      if (soonest === undefined || at < soonest) {
        soonest = at;
      }
    }
    if (soonest === undefined) {
      // Nothing ahead to arm for — but a chat parked across the restart, whose
      // reset has since passed, still needs a look at what credit there is now.
      // The reading it triggers resumes it (`creditResume.observedUsable`).
      if (daemon.hasCreditParks()) void accountUsage?.refreshAll(true);
      return;
    }
    // WHICH key that chat spent is not on disk, so none is sidelined: a guess
    // blamed the wrong account for the whole host. The reset is armed without
    // an account, and the probe below says what each account really has.
    void accountUsage?.refreshAll(true);
    logger.info({ at: soonest }, 'credit retry: re-armed after restart from a failed chat on disk');
    creditResume.arm(soonest);
  };

  // Boot: an event-driven retry needs its event armed, and a restart forgot it.
  armCreditRetryFromDisk();

  const claudeCliTimer = setInterval(() => {
    void refreshClaudeCli().catch((err: unknown) => {
      logger.warn({ err }, 'claude-cli-update: update failed');
    });
  }, CLAUDE_CLI_CHECK_INTERVAL_MS);
  claudeCliTimer.unref?.();

  const app = await buildControl({
    toolPromptOverrides: () => toolPromptOverrides,
    logger: true,
    daemon,
    localKey,
    jobs,
    // spec/02 § Control IPC — every host-scoped control this host owns, over
    // the local socket, driving the SAME operations as the `host.*` wire frames
    // so `patch` on the host itself needs no round trip through the server.
    host: {
      describe: () => describeHost(),
      folders: {
        snapshot: () => folderRegistry.split(),
        add: (path) => {
          folderRegistry.register(path);
          emit({ type: 'folders.updated', hostId: selfHostId, ...folderRegistry.snapshot() });
        },
        remove: (path) => {
          const removed = folderRegistry.unregister(path);
          if (removed) {
            emit({ type: 'folders.updated', hostId: selfHostId, ...folderRegistry.snapshot() });
          }
          return removed;
        },
      },
      claudeSettings: {
        snapshot: claudeSettingsSnapshot,
        set: (text) => {
          writeClaudeSettingsJson(claudeHome, text);
          emit({
            type: 'claude_settings.updated',
            hostId: selfHostId,
            ...claudeSettingsSnapshot(),
          });
        },
        deleteMemory: (project, file) => {
          deleteClaudeMemory(config.claudeProjectsRoot, project, file);
          emit({
            type: 'claude_settings.updated',
            hostId: selfHostId,
            ...claudeSettingsSnapshot(),
          });
        },
      },
      backends: {
        list: () => describeHost().backends,
        accounts: () => buildAccountReport().accounts,
      },
      models: async () => {
        const outcomes = await Promise.allSettled([
          modelCatalog.get().then((r) => r.models),
          codexAccounts.models(),
        ]);
        return {
          models: outcomes.flatMap((r, i) =>
            r.status === 'fulfilled'
              ? r.value.map((m) => ({
                  ...m,
                  backend: i === 0 ? CLAUDE_BACKEND_ID : CODEX_BACKEND_ID,
                }))
              : [],
          ),
          errors: outcomes.flatMap((r, i) =>
            r.status === 'rejected'
              ? [
                  {
                    backend: i === 0 ? CLAUDE_BACKEND_ID : CODEX_BACKEND_ID,
                    message: String(r.reason),
                  },
                ]
              : [],
          ),
        };
      },
      components: {
        install: (componentId) => {
          components.install(componentId);
          emit(describeHost());
        },
        remove: (componentId) => {
          components.remove(componentId);
          emit(describeHost());
        },
      },
      update: async () => {
        const result = await applyUpdateOnce();
        // A refused apply (nothing newer, bad digest, bad signature) is
        // reported as refused with the reason — never as a quiet success.
        if (!result.applied && !result.deferred) {
          logger.warn({ reason: result.message }, 'host.update refused');
        }
        return result;
      },
    },
    // spec/03 § Cross-chat tools — the host roster the server pushes, so an
    // agent's `patch_spawn` naming a host that is down fails inside the turn
    // instead of buffering.
    isHostOnline: (hostId: string) => hostId === selfHostId || onlineHosts.has(hostId),
    // spec/03 § Cross-chat tools — a spawn on ANOTHER host resolves on that
    // host's own answer, so a refusal there fails the tool call here.
    spawnOnRemoteHost,
    // The account-wide chat list (every host's chats, each naming its own).
    listAccountChats: (sourceChatId, archived) => requestAccountChats(sourceChatId, archived),
    searchAccountChats: (sourceChatId, query, limit) => requestSearch(sourceChatId, query, limit),
    // `patch_activity` — the user's own messages (gathered by the server from every host's chat logs) and, on request, chat dwell sessions.
    getActivity: (
      sourceChatId,
      since,
      until,
      messagesCursor,
      limit,
      includeSessions,
      sessionsCursor,
    ) =>
      requestActivity(
        sourceChatId,
        since,
        until,
        messagesCursor,
        limit,
        includeSessions,
        sessionsCursor,
      ),
    // spec/03 § Cross-chat tools — patch_peek/patch_history read the server's
    // record; send_to/stop to a chat on another host go to its owner.
    runsManager: () => runsManager,
    peekFromServer,
    historyFromServer,
    sendToRemoteChat,
    stopRemoteChat,
    // spec/07 § Agent-initiated voice — an app call already open takes the
    // message as speech instead of a ring. Late-bound: the audio server starts
    // after buildControl, and is up long before any tool call lands.
    interruptOpenCall: (text: string) => audioServer?.interruptOpenCall(text) ?? false,
    endOpenCall: async (chatId: string, goodbye?: string) =>
      (await audioServer?.endOpenCall(chatId, goodbye)) ?? false,
    agentsCanCall: () => agentsCanCall,
    emitWire: emit,
    publishArtifact: artifactPublisher.publish,
    padRequest: padClient.request,
    accountsRpc: accountsClient.request,
    serverApi: serverApiClient.request,
    serverEvents: serverEventsClient,
    heldAccounts: heldAccountsFor,
    meetingAgentEdit: (chatId, edit) => meetings!.agentEdit(chatId, edit),
    // Live link diagnostics + spec/12 link-drop control on the control UDS.
    serverLink: {
      diagnostics: () => link.diagnostics(),
      dropLink: () => link.dropLink(),
      floodBuffer: (chatId, count) => link.floodBuffer(chatId, count),
    },
    onShutdown: () => shutdownHook?.(),
    toolLogger: (entry) => {
      logger.info(entry, 'cross-chat tool call');
      toolLogSink.append({ ts: Date.now(), ...entry });
    },
    onBroadcast: ({ channel, message, sourceChatId }) => {
      const threadId = threadForChannel(channel);
      if (!threadId) return;
      // Group 12 (DX-1): a thread firing patch_notify on its OWN channel
      // (e.g. thread_speakers → speakers) would otherwise self-loop —
      // appending to its own broadcasts.jsonl, then reading the entry back
      // as a note on its next user turn. Suppress same-channel
      // self-loops; any other chat broadcasting on speakers still appends
      // normally.
      if (isBroadcastSelfLoop(channel, sourceChatId)) {
        logger.info(
          { channel, sourceChatId },
          'broadcast self-loop suppressed (thread fired on its own channel)',
        );
        return;
      }
      const sourceState = daemon.chatState.get(sourceChatId);
      const sourceChatName = sourceState?.name ?? sourceChatId;
      appendBroadcast(hostCwd, threadId, {
        ts: Date.now(),
        sourceChatName,
        message,
      });
    },
  });
  const socketDir = dirname(config.socketPath);
  if (!isNamedPipe(config.socketPath) && !existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }
  // A Windows named pipe is not a file: nothing to unlink or chmod.
  const socketIsFile = !isNamedPipe(config.socketPath);
  if (socketIsFile && existsSync(config.socketPath)) {
    const stat = statSync(config.socketPath);
    if (!stat.isSocket()) {
      throw new Error(
        `Refusing to remove non-socket file at ${config.socketPath}; resolve manually.`,
      );
    }
    unlinkSync(config.socketPath);
  }
  await app.listen({ path: config.socketPath });
  // Lock down the UDS — Fastify's listen({path}) doesn't expose mode.
  if (socketIsFile) chmodSync(config.socketPath, 0o600);
  logger.info({ socket: config.socketPath }, 'patch-daemon control listening on UDS');
  linkLegacySocket(config.socketPath);

  // 8. Voice infrastructure (group 13): audio WSS at :3003/audio/<sessionId>.
  //    (The server-link dial happens earlier — right after the host graph is
  //    wired — so surfaces connect promptly rather than waiting on this stack.)
  const whisperLog = logger.child({ component: 'whisper' });
  // spec/02 § Optional components: installing the speech model is what turns
  // local speech-to-text ON, the same contract as Kokoro below. A machine that
  // has the Whisper component (weights verified, runtime built) transcribes
  // with it unless the speech setting names an engine; a named engine still
  // wins (`mock` for tests, `off` to hold a machine quiet, or a hosted engine).
  const whisperFromComponent = (): boolean =>
    config.audio.speechAuto &&
    components.describe().find((c) => c.id === 'whisper')?.state === 'installed';
  // spec/02 § Speech set-up: a Groq key the user added in Settings → Providers is
  // the cloud route, chosen by adding it. With no env var and no installed
  // component it makes this host transcribe with Groq; an installed local model
  // wins because it costs nothing.
  const whisperFromKey = (): boolean =>
    config.audio.speechAuto && !whisperFromComponent() && providerKeys.has('groq');
  const buildWhisper = (): WhisperBackend => {
    if (whisperFromKey()) {
      logger.info({ component: 'whisper' }, 'STT enabled: a Groq key is set');
      return createWhisper({
        backend: 'groq',
        logger: whisperLog,
        groqApiKey: () => providerKeys.get('groq'),
      });
    }
    if (config.audio.whisperBackend === 'elevenlabs') {
      return new ElevenLabsScribeBackend({
        logger: whisperLog,
        apiKey: () => providerKeys.get('elevenlabs'),
      });
    }
    if (whisperFromComponent()) {
      logger.info(
        { component: 'whisper' },
        'STT enabled: the Whisper component is installed on this machine',
      );
      const sidecarDir = process.env['WHISPER_SIDECAR_CWD'] ?? bundledSidecarDir('whisper');
      return createWhisper({
        backend: 'local',
        logger: whisperLog,
        localModelPath: join(config.patchHome, 'components', 'whisper'),
        localSidecarCwd: sidecarDir,
        localSidecarEnv: {
          UV_PROJECT_ENVIRONMENT: components.runtimeDir('whisper'),
          // Import the sidecar from THIS host version's source (see the Kokoro
          // note below: an update prunes the folder the venv was built from).
          PYTHONPATH: join(sidecarDir, 'src'),
        },
        uvPath: uvCandidates(config.patchHome).find((p) => existsSync(p)) ?? 'uv',
      });
    }
    return createWhisper({
      backend: config.audio.whisperBackend,
      logger: whisperLog,
      groqApiKey: () => providerKeys.get('groq'),
      ...(config.audio.parakeetModelDir !== undefined
        ? { parakeetModelDir: config.audio.parakeetModelDir }
        : {}),
      sherpaEntry: () => voiceLoc().sherpaEntry,
      ...(config.audio.whisperLocalSidecarUrl !== undefined
        ? { localSidecarUrl: config.audio.whisperLocalSidecarUrl }
        : {}),
      ...(config.audio.whisperModelPath !== undefined
        ? { localModelPath: config.audio.whisperModelPath }
        : {}),
      // Spawn the faster-whisper sidecar from its package dir when local mode is
      // self-hosted (no external URL). WHISPER_SIDECAR_CWD overrides for docker.
      ...(config.audio.whisperBackend === 'local' &&
      config.audio.whisperLocalSidecarUrl === undefined
        ? {
            localSidecarCwd:
              process.env['WHISPER_SIDECAR_CWD'] ??
              resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'whisper-sidecar'),
          }
        : {}),
    });
  };
  const installWhisper = (next: WhisperBackend): void => {
    whisper = next;
    if (meetingTranscriptionModel !== '') next.useModel?.(meetingTranscriptionModel);
    dictationTranscribers = createDictationTranscribers({
      logger: logger.child({ component: 'hosted-stt' }),
      local: next,
      deepgramApiKey: () => providerKeys.get('deepgram'),
      elevenlabsApiKey: () => providerKeys.get('elevenlabs'),
    });
  };
  installWhisper(buildWhisper());
  // The account's `speechToText` choice (spec/07 § Speech to text): what reads
  // speech on a turn-based call. Each engine is this host's own or it is
  // refused by name — never swapped for the one WHISPER_BACKEND started with.
  // Backends this resolver created itself (each opens connections or a sidecar,
  // so one per engine); the host's own `whisper` is reused when it is that engine.
  const ownStt = new Map<string, WhisperBackend>();
  const own = (engine: string, make: () => WhisperBackend): WhisperBackend => {
    let b = ownStt.get(engine);
    if (!b) {
      b = make();
      ownStt.set(engine, b);
    }
    return b;
  };
  const sttEngineResolver = createSpeechToTextResolver({
    build: (engine) => {
      // WHISPER_BACKEND=mock is the test host: its one canned reader stands in
      // for whichever engine the account picked, so no engine needs a key or model.
      if (config.audio.whisperBackend === 'mock' && whisper !== undefined) return { whisper };
      if (engine === 'groq') {
        if (providerKeys.get('groq') === undefined) {
          return {
            unavailable: 'no Groq key is set on this host (add it in Settings → Providers)',
          };
        }
        return {
          whisper:
            whisper instanceof GroqWhisperBackend
              ? whisper
              : own('groq', () =>
                  createWhisper({
                    backend: 'groq',
                    logger: whisperLog,
                    groqApiKey: () => providerKeys.get('groq'),
                  }),
                ),
        };
      }
      if (engine === 'elevenlabs') {
        if (providerKeys.get('elevenlabs') === undefined) {
          return {
            unavailable: 'no ElevenLabs key is set on this host (add it in Settings → Providers)',
          };
        }
        return {
          whisper:
            whisper instanceof ElevenLabsScribeBackend
              ? whisper
              : own(
                  'elevenlabs',
                  () =>
                    new ElevenLabsScribeBackend({
                      logger: whisperLog,
                      apiKey: () => providerKeys.get('elevenlabs'),
                    }),
                ),
        };
      }
      if (engine === 'parakeet') {
        const dir = config.audio.parakeetModelDir;
        if (dir === undefined || !existsSync(dir)) {
          return {
            unavailable: 'the Parakeet model is not installed on this host (PARAKEET_MODEL_DIR)',
          };
        }
        return {
          whisper:
            whisper instanceof ParakeetWhisperBackend
              ? whisper
              : own('parakeet', () =>
                  createWhisper({ backend: 'parakeet', logger: whisperLog, parakeetModelDir: dir }),
                ),
        };
      }
      // engine === 'whisper'
      if (whisper instanceof LocalWhisperBackend) return { whisper };
      const modelDir = join(config.patchHome, 'components', 'whisper');
      const installed =
        components.describe().find((c) => c.id === 'whisper')?.state === 'installed' &&
        existsSync(join(modelDir, 'model.bin'));
      if (!installed) {
        return {
          unavailable:
            'the Whisper model is not installed on this host (Settings → Hosts → Components)',
        };
      }
      const sidecarDir = process.env['WHISPER_SIDECAR_CWD'] ?? bundledSidecarDir('whisper');
      return {
        whisper: own('whisper', () =>
          createWhisper({
            backend: 'local',
            logger: whisperLog,
            localModelPath: modelDir,
            localSidecarCwd: sidecarDir,
            localSidecarEnv: {
              UV_PROJECT_ENVIRONMENT: components.runtimeDir('whisper'),
              PYTHONPATH: join(sidecarDir, 'src'),
            },
            uvPath: uvCandidates(config.patchHome).find((p) => existsSync(p)) ?? 'uv',
          }),
        ),
      };
    },
  });
  // The on-host model loads now: a broken install aborts the boot rather
  // than failing the first word someone says.
  // An installed host without the voice component boots anyway; Parakeet then
  // names the missing component on first use rather than at boot.
  if (
    config.audio.whisperBackend === 'parakeet' &&
    (!isArtifact || voiceComponentInstalled(voiceDir))
  ) {
    await (whisper as ParakeetWhisperBackend).warm();
  }
  // The streaming model for dictation on the `host` engine loads now too.
  if (config.audio.parakeetStreamingModelDir !== undefined) {
    liveRecognizer = new ParakeetLiveRecognizer({
      logger: logger.child({ component: 'parakeet-live' }),
      modelDir: config.audio.parakeetStreamingModelDir,
      sherpaEntry: () => voiceLoc().sherpaEntry,
    });
    if (!isArtifact || voiceComponentInstalled(voiceDir)) await liveRecognizer.warm();
  }
  // Installing or removing the Whisper component takes effect at once, not at
  // the next restart: the engine follows the component.
  const repickWhisper = (): void => {
    const current = whisper;
    if (current === undefined) return;
    if (!config.audio.speechAuto) return;
    const want = whisperFromComponent() ? 'local' : whisperFromKey() ? 'groq' : 'off';
    const have =
      current instanceof UnconfiguredWhisperBackend
        ? 'off'
        : current instanceof LocalWhisperBackend
          ? 'local'
          : 'groq';
    if (want === have) return;
    installWhisper(buildWhisper());
    void current.close().catch(() => undefined);
  };
  onSpeechBackendChanged = (): void => {
    const current = whisper;
    if (current === undefined) return;
    installWhisper(buildWhisper());
    void current.close().catch(() => undefined);
    if (config.audio.whisperBackend === 'parakeet') {
      void (whisper as ParakeetWhisperBackend).warm().catch((err: unknown) => {
        logger.error({ err: String(err) }, 'speech engine parakeet failed to load');
      });
    }
  };
  onComponentsSettled = repickWhisper;
  onSpeechKeysChanged = repickWhisper;
  // spec/02 § Optional components: voice is a component the user installs on a
  // host, and installing it is what turns it ON. A host that has installed
  // Kokoro — weights verified AND its Python runtime built — can speak, whether
  // or not anything set KOKORO_BACKEND, because the install IS the explicit
  // choice the env var otherwise stands for. (An env var still wins: `mock` for
  // tests, `off` to hold a host quiet.) This is what the docker image gets
  // from baking the venv at build time; an artifact-installed host now gets it
  // from having been asked for it.
  // `installed` already requires the runtime stamp (components.ts settledState).
  const kokoroInstalled =
    components.describe().find((c) => c.id === 'kokoro')?.state === 'installed';
  const kokoroBackend =
    process.env['KOKORO_BACKEND'] === undefined && kokoroInstalled
      ? ('real' as const)
      : config.audio.kokoroBackend;
  if (kokoroBackend !== config.audio.kokoroBackend) {
    logger.info(
      { component: 'kokoro' },
      'TTS enabled: the Kokoro component is installed on this host',
    );
  }
  const kokoro = createKokoro({
    backend: kokoroBackend,
    logger: logger.child({ component: 'kokoro' }),
    ...(config.audio.kokoroSidecarUrl !== undefined
      ? { sidecarUrl: config.audio.kokoroSidecarUrl }
      : {}),
    ...(config.audio.kokoroModelPath !== undefined
      ? { modelPath: config.audio.kokoroModelPath }
      : {}),
    // When no external KOKORO_SIDECAR_URL is set, the host spawns the
    // `patch_kokoro_sidecar` itself; run `uv run` in the sidecar package dir
    // so the module resolves. KOKORO_SIDECAR_CWD overrides for non-standard
    // layouts (e.g. docker images that vendor the sidecar elsewhere).
    //
    // The `??` fallback below is deliberately never exercised: the boot test
    // for this branch (KOKORO_BACKEND=real with no sidecar URL) always sets
    // KOKORO_SIDECAR_CWD to a throwaway temp path, on purpose. Falling
    // through to this default resolves to the REAL `packages/kokoro-sidecar`
    // directory in this repo, and the kokoro prewarm that immediately
    // follows would `uv run` a genuine subprocess there (real venv, real
    // `patch_kokoro_sidecar` module) — the same class of "test accidentally
    // does something real" risk this session already hit once for real (see
    // the `~/.claude.json` CLAUDE_CONFIG_PATH comment in bootMain). The
    // expression itself is a trivial two-segment `resolve()` path join with
    // no branching of its own.
    ...(kokoroBackend === 'real' && config.audio.kokoroSidecarUrl === undefined
      ? {
          /* v8 ignore next 3 */
          sidecarCwd: process.env['KOKORO_SIDECAR_CWD'] ?? bundledSidecarDir('kokoro'),
          // The venv the component install built for this host. `uv run
          // --no-sync` uses it as-is; without it, `uv` would resolve a fresh
          // environment inside the artifact — read-only on some installs, and
          // several GB of wheels the host already has.
          sidecarEnv: {
            UV_PROJECT_ENVIRONMENT: components.runtimeDir('kokoro'),
            // Import the sidecar from THIS host version's source. The venv's
            // own install is an editable link to whichever version folder built
            // it, and an update prunes that folder: on 2026-09-25 every spawn
            // died with "No module named patch_kokoro_sidecar" after 0.1.1064
            // was removed, while the venv still counted as provisioned.
            /* v8 ignore next */
            PYTHONPATH: join(
              process.env['KOKORO_SIDECAR_CWD'] ?? bundledSidecarDir('kokoro'),
              'src',
            ),
          },
          // A host that had no `uv` got one during the install, in the patch
          // home rather than on PATH — so name it rather than hoping.
          uvPath: uvCandidates(config.patchHome).find((p) => existsSync(p)) ?? 'uv',
        }
      : {}),
  });
  // Pre-warm the Kokoro sidecar at boot (real backend only) so the model load
  // (~327 MB weights + spaCy, several seconds) happens off the FIRST voice
  // call's critical path. Fire-and-forget: never blocks host readiness, and a
  // warm failure is non-fatal (the lazy spawn on first real synth still works).
  /**
   * Synthesise a throwaway phrase and discard it, so the model is resident and
   * hot when a real reply needs speaking. Drains the iterator — the point is
   * the work, not the audio.
   */
  const warmKokoro = async (): Promise<void> => {
    const warm = await kokoro.synthesize('Ready.');
    for await (const chunk of warm.iterator) {
      void chunk; // drain + discard — we only want the model resident in the sidecar.
    }
  };
  if (kokoroBackend === 'real') {
    void (async () => {
      try {
        await warmKokoro();
        logger.info({ component: 'kokoro' }, 'kokoro sidecar pre-warmed');
        /* v8 ignore start -- RealKokoroBackend's synthesize()/iterator
         * contract (src/audio/kokoro.ts) deliberately converts every
         * mid-stream sidecar failure into a `requestPromise.catch()` that
         * logs a warn and ends the iterator gracefully (empty), rather than
         * rejecting — verified by reading that implementation and confirmed
         * empirically in test/index-main.test.ts's "no sidecar listening"
         * prewarm case, which still resolves cleanly. The only way to reach
         * THIS catch is `kokoro.synthesize()` itself throwing synchronously
         * (e.g. `ensureProcess()`'s missing-modelPath guard), which can't
         * happen here: `validateKokoroModel` already refuses to boot at all
         * without a real KOKORO_MODEL_PATH. Kept as a genuine NO FALLBACK
         * safety net against a future kokoro.ts contract change, not gamed
         * away. */
      } catch (err) {
        logger.warn(
          { component: 'kokoro', err: (err as Error).message },
          'kokoro pre-warm failed (non-fatal)',
        );
      }
      /* v8 ignore stop */
    })();
    // KEEP it warm, don't just start it warm. The boot pre-warm alone left the
    // first call after a quiet hour paying the whole model load again —
    // measured at 19s to first audio, against a ~200ms budget — because the
    // weights get paged out while the box does something else. By then the user
    // has hung up, which reads as "the call doesn't speak". A short synthesis on
    // a slow timer keeps the weights resident for the cost of a few hundred ms
    // of CPU an interval.
    const keepWarm = setInterval(() => {
      void warmKokoro().catch((err: Error) => {
        logger.warn({ component: 'kokoro', err: err.message }, 'kokoro keep-warm failed');
      });
    }, KOKORO_KEEP_WARM_MS);
    keepWarm.unref();
  }
  // VAD factory: with VAD_BACKEND=silero load the real onnxruntime session once
  // (validated at boot above) and build a fresh per-session Vad reusing it; the
  // mock backend stays the docker-compose/test default. NO silent fallback —
  // a silero load failure throws and aborts boot.
  // Installed host, no VAD_MODEL_PATH: the model and onnxruntime come from the
  // voice component. Loaded at boot when it is installed, and again when an
  // install settles; until then a session that needs VAD is refused by name
  // (VoiceComponentMissingError → `voice_component_missing`), never run without.
  let componentVad: (() => Vad) | undefined;
  const loadComponentVad = async (): Promise<void> => {
    const loc = voiceLoc();
    componentVad = await createSileroVadFactory({
      modelPath: loc.vadModel as string,
      nativeDir: loc.nativeDir,
    });
  };
  const useComponentVad =
    config.audio.vadBackend === 'silero' && isArtifact && config.audio.vadModelPath === undefined;
  if (useComponentVad && voiceComponentInstalled(voiceDir)) await loadComponentVad();
  const settleRepickWhisper = onComponentsSettled;
  onComponentsSettled = (): void => {
    settleRepickWhisper();
    if (!useComponentVad) return;
    if (!voiceComponentInstalled(voiceDir)) {
      componentVad = undefined;
    } else if (componentVad === undefined) {
      void loadComponentVad().catch((err: unknown) => {
        logger.error({ err: String(err) }, 'voice component installed but VAD failed to load');
      });
    }
  };
  const makeVad: () => Vad =
    config.audio.vadBackend !== 'silero'
      ? (): Vad => new MockVad()
      : useComponentVad
        ? (): Vad => {
            if (componentVad === undefined) throw new VoiceComponentMissingError();
            return componentVad();
          }
        : config.audio.vadModelPath !== undefined
          ? await createSileroVadFactory({
              modelPath: config.audio.vadModelPath,
              nativeDir: voiceLoc().nativeDir,
            })
          : (): Vad => new MockVad();

  audioServer = await startAudioServer({
    ...(testHooks?.geminiWsCtor ? { geminiWsCtor: testHooks.geminiWsCtor } : {}),
    host: config.audio.host,
    port: config.audio.port,
    logger: logger.child({ component: 'audio' }),
    internalToken: config.internalToken,
    // Forwards to whichever engine is current, so installing the speech model
    // reaches voice sessions too, without a restart.
    whisper: new Proxy({} as WhisperBackend, {
      get: (_t, key) => {
        const cur = whisper as unknown as Record<PropertyKey, unknown>;
        const v = cur[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(cur) : v;
      },
    }),
    // Every place that speaks goes through this: the voice session (calls, house
    // speakers, announcements) takes whichever engine Settings chose.
    kokoro: createRoutedTts({ kokoro, elevenlabs, choice: () => ttsBackend }),
    makeVad,
    maxConcurrentSessions: config.audio.maxConcurrentSessions,
    // E1-d3: a voice session must bind to a chat that exists. Check live
    // chat state first, then fall back to the on-disk meta store (a chat
    // resumable from disk still exists, even if not currently hydrated).
    chatExists: (chatId: string): boolean =>
      daemon.chatState.has(chatId) || metaStore.read(chatId) !== undefined,
    // spec/14 ## Sidebar + spec/16 — a voice-device session opening or
    // closing drives the "mid-session" pill across all surfaces.
    // `device.session` is account-scoped (no chatId) so the server fans it out
    // to every connected surface. Devices are known to the server, not to
    // hosts, so the pill names the device by its id.
    onDeviceSession: (deviceId, active) => {
      emit({ type: 'device.session', deviceId, name: deviceId, active });
    },
    // spec/07 § A call can move between devices — account-scoped, so every
    // surface learns a call is live on this chat and can offer to take it.
    onCallSession: ({ resumed, ...info }) => {
      emit({ type: 'voice.call', ...info, surfaceKind: String(info.surfaceKind) });
      // spec/07 § A dropped call comes back — said in the chat, so a call that
      // was cut and redialled is never silently a different call.
      if (info.active && resumed === true) {
        try {
          daemon.recordCallNote(info.chatId, CALL_RESUMED_NOTE);
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'voice: could not note the redialled call');
        }
      }
    },
    submitUserTurn: async ({ chatId, message, source, onReplyText }) => {
      // Tag the turn by its ingress. Physical voice devices get
      // `[voice • device:<deviceId>]` (spec/06 ## Speakers thread) so the
      // agent knows which room it's hearing; app surfaces get
      // `[voice • <surfaceKind>]`. The same audio WSS streams the reply's TTS
      // back to the originating session, which IS the originating device.
      const voicePrefix = voiceTag(source, false);
      // Unique per turn: the reply bridge recognises this turn's own message by it.
      const localId = voiceLocalId(source);
      // Register BEFORE the input is sent, so the bridge sees this turn's very
      // first message and every delta after it. Armed by that message only: the chat
      // may be running some other turn right now, with this one queued behind it.
      const replyPromise = voiceReplies.awaitReply(chatId, onReplyText, localId);
      // The promise is awaited only after `sendInput` returns. A newer turn can supersede
      // (reject) it before then, with nothing attached yet: Node would treat that as an
      // unhandled rejection and exit the whole daemon. Mark it observed here; the real
      // handling is still the `await replyPromise` below, which sees the same rejection.
      replyPromise.catch(() => {});
      // `sendInput` awaits the whole turn (and any turns that queue behind it),
      // so by the time it returns the bridge has normally already settled. If
      // it THROWS, the turn never ran — fail the waiter loudly instead of
      // leaving the session waiting on a promise nothing will ever resolve.
      try {
        await daemon.sendInput({ chatId, message, localId, voicePrefix, fromUser: true });
      } catch (err) {
        voiceReplies.abandon(chatId, err as Error);
        throw err;
      }
      return (await replyPromise).text;
    },
    // spec/07 ## Permission prompts during voice — a spoken yes/no mid-call
    // resolves the focused chat's outstanding permission via the STT path.
    getPendingPermission: (chatId: string) => daemon.getPendingPermissionForChat(chatId),
    resolvePermission: (requestId: string, approve: boolean) =>
      daemon.submitPermissionResponse({ requestId, decision: approve ? 'approve' : 'deny' }),
    // Voice-in-settings: read the live value so a settings change takes effect
    // on the next utterance without restarting an open session.
    // The voice for whichever engine is chosen: read per utterance.
    getKokoroVoice: () => (ttsBackend === 'elevenlabs' ? elevenLabsVoice : kokoroVoice),
    // spec/07 § Voice — live read, same pattern as getKokoroVoice above.
    getVoiceConfig: () => voiceConfig,
    resolveSpeechToText: sttEngineResolver,
    getVoiceAgent: () => voiceAgent,
    getVoiceTones: () => voiceTones,
    getVoiceCatalog: (provider) => voiceCatalog.entry(provider),
    getDeviceDictation: () => deviceDictation,
    geminiApiKey: () => providerKeys.get('gemini'),
    deepgramApiKey: () => providerKeys.get('deepgram'),
    elevenlabsApiKey: () => providerKeys.get('elevenlabs'),
    ...(liveRecognizer ? { liveRecognizer } : {}),
    openaiApiKey: () => providerKeys.get('openai'),
    elevenLabsApiKey: () => providerKeys.get('elevenlabs'),
    // spec/07 § The voice agent and the chat's agent — the voice agent's tools the host
    // answers and the chat's start context, the same for every provider.
    voiceAgentLink: chatVoice.link,
    getVoiceInstructions: () => voiceInstructions,
    managerVoice,
    // spec/16 — a device is heard out loud, and by whoever is in the room.
    deviceVoice: () => ({
      prompt: () => voiceDevicePrompt,
      profiles: () => voiceProfiles,
      threshold: () => voiceMatchThreshold,
      ...(speakerId.available()
        ? { embed: (pcm: Int16Array) => speakerId.embed(pcm), warm: () => speakerId.warm() }
        : {}),
      recent: recentVoices,
    }),
    makeTimeline: (init) => chatVoice.makeTimeline(init),
    onCallEnded: (info) => chatVoice.callEnded(info),
  });

  if (config.sdkBackend === 'real') void codexAccounts.start();

  // 9. Graceful shutdown.
  const shutdownSpeakerId = (): Promise<void> => speakerId.close();
  const shutdown = async (): Promise<void> => {
    // spec/12 § Chat status — every stop of the host is one it chose (a
    // self-update, a service restart, a signal), so the server hears it first
    // and shows this host's working chats as Host restarting, not Host offline.
    link.send({ type: 'host.restarting', hostId: selfHostId });
    // Turns outlive the host (spec/02): let go of each one's runner first, so
    // nothing below ends a turn that is meant to carry on under the next host.
    clearInterval(healthTimer);
    healthSampler.stop();
    void shutdownSpeakerId();
    daemon.beginShutdown();
    const detached = detachDurableTurns();
    if (detached > 0) logger.info({ turns: detached }, 'patch-daemon: left turns running');
    homeLock.release();
    logger.info('patch-daemon: shutting down');
    const began = Date.now();
    const report = (r: StepReport): void => {
      if (r.overran || r.error !== undefined) {
        logger.warn({ ...r }, 'patch-daemon: shutdown step did not finish in its budget');
      } else {
        logger.debug({ ...r }, 'patch-daemon: shutdown step done');
      }
    };
    // spec/04 § History — everything the history log was told is on disk
    // before the process goes (the batch fsync would otherwise lose up to 1 s).
    // Only chats that moved are written, so this does not scale with how many
    // chats the host has loaded.
    try {
      daemon.flushHistory();
    } catch (err) {
      logger.error({ err }, 'patch-daemon: history log flush failed on shutdown');
    }
    // Everything that can wait on something outside the host runs together,
    // each with its own budget (shutdownSteps.ts): one slow close must not
    // hold up the rest, nor run the whole shutdown into its hard deadline.
    // Every terminal session belongs to its own runner, which keeps running
    // for the next host to reattach (spec/02 § Host restarts); the host only
    // lets go of it. Terminals go before the server link.
    // Host searches die with the host too — a surface mid-search just gets no
    // more frames for that `searchId`.
    hostSearch.cancelAll();
    // Script runs keep going; the next host picks them up.
    jobRuns.dispose();
    audioRelayBridge.dispose();
    await runShutdownSteps(
      [
        { name: 'codex accounts', run: () => codexAccounts.close() },
        { name: 'terminals', run: () => terminals.shutdown() },
        { name: 'audio server', run: () => audioServer?.close() },
        { name: 'kokoro', run: () => kokoro.close() },
        { name: 'whisper', run: () => whisper?.close() },
        { name: 'live recognizer', run: () => liveRecognizer?.close() },
      ],
      { log: report },
    );
    await runShutdownSteps(
      [
        { name: 'server link', run: () => link.close() },
        { name: 'control socket', run: () => app.close() },
      ],
      { log: report },
    );
    logger.info({ ms: Date.now() - began }, 'patch-daemon: shutdown steps finished');
    tcp.close();
  };
  // Wire the control-IPC POST /stop endpoint to graceful shutdown.
  const stop = (): void =>
    shutdownThenExit(shutdown, {
      exit: (code) => process.exit(code),
      onDeadline: () =>
        logger.error(
          { deadlineMs: SHUTDOWN_DEADLINE_MS },
          'patch-daemon: graceful shutdown overran its deadline — exiting anyway',
        ),
    });
  shutdownHook = () => {
    noteShutdown('control-stop', 'POST /stop on the control socket (patch CLI or a host surface)');
    stop();
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    noteShutdown(sig, 'signal received', signalContext());
    stop();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  testHooks?.onReady?.({
    shutdown,
    daemon,
    folderRegistry,
    secretsStore,
    app,
    // The unwrapped backend: a test enqueues scripted runs on the mock.
    sdkBackend: rawSdkBackend,
  });
}

/**
 * Group 19: server asked for a directory listing under a chat's pinned
 * folder. Resolve via chatState, sandbox, and reply on the same WS peer.
 */
// List the skills a chat in `folder` can actually invoke — what typing `/name`
// in the composer would reach (spec/14 § Composer — skill autocomplete). Backs
// the job-editor's Skill picker too (the host owns the project filesystem;
// the server round-trips this RPC). A folder with none is NOT an error.
//
// Two places, because a skill is either the project's or the host's, and a
// host-level skill applies in every folder on it — so the picker offered
// less than the agent behind it would actually run:
//
//   <folder>/.claude/skills      the project's own
//   ~/.claude/skills             the host's, which apply in every folder
//
// SKILLS ONLY — `.claude/commands` is deliberately not read. A command is a
// different thing from a skill and the picker is not a list of everything that
// could be typed after a slash.
//
// Symlinks are followed: a skills directory is often a link to where the repo
// really keeps them, so entries are stat'd rather than read off the dirent's own
// type, which reports a symlinked skill as neither file nor directory.
export async function handleSkillsRequest(
  event: import('@patch/wire').PatchSkillsRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  const { readdirSync, existsSync, statSync, readFileSync } = await import('node:fs');
  const { resolve: pathResolve, join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { parseFrontmatterFields } = await import('./claudeSettings.js');
  const { skillDirs } = await import('./projectSkills.js');
  const folder = pathResolve(event.folder);
  if (!existsSync(folder)) {
    sender({
      type: 'patch.skills.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'folder_not_found', message: `folder not found: ${event.folder}` },
    });
    return;
  }
  /**
   * What one directory offers, in either shape: the skill's name paired with
   * the file that defines it. The path is kept AS JOINED (not realpath'd) so a
   * skills directory that is a symlink still reports its file under `folder` —
   * a surface resolves the path against the folder to reach it.
   */
  const skillsIn = (dir: string): Array<[name: string, file: string]> => {
    if (!existsSync(dir)) return [];
    const out: Array<[string, string]> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      let isDir: boolean;
      try {
        // `stat`, not the dirent: a symlinked skill reports as a symlink, and
        // this layout is built out of symlinks.
        isDir = statSync(path).isDirectory();
      } catch {
        continue; // a dangling symlink offers nothing.
      }
      if (isDir) {
        if (existsSync(join(path, 'SKILL.md'))) out.push([entry.name, join(path, 'SKILL.md')]);
      } else if (entry.name.endsWith('.md')) {
        out.push([entry.name.slice(0, -'.md'.length), path]);
      }
    }
    return out;
  };
  const home = process.env['HOME'] ?? homedir();
  try {
    // The project's own skills first, so a name defined in both places resolves
    // to the project's copy — the same precedence the name list has always had.
    const paths: Record<string, string> = {};
    for (const [name, file] of skillDirs(folder, home).flatMap(skillsIn)) {
      paths[name] ??= file;
    }
    const names = Object.keys(paths).sort();
    // Each skill's WHOLE frontmatter block, keyed by field name
    // (`parseFrontmatterFields` in `claudeSettings.ts`) — plus `descriptions`,
    // kept alongside for a surface still on an older wire contract that only
    // reads that field. A file that fails to read, or whose frontmatter has no
    // fields at all, is left out of both maps rather than added empty — "no
    // frontmatter found" and "found, and it's empty" are different facts.
    const descriptions: Record<string, string> = {};
    const frontmatter: Record<string, Record<string, string>> = {};
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(paths[name]!, 'utf8');
      } catch {
        continue;
      }
      const fields = parseFrontmatterFields(text);
      if (Object.keys(fields).length > 0) frontmatter[name] = fields;
      if (fields.description) descriptions[name] = fields.description;
    }
    sender({
      type: 'patch.skills.response',
      requestId: event.requestId,
      ok: true,
      skills: names,
      paths,
      descriptions,
      frontmatter,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, folder: event.folder },
      'patch.skills.request: list failed',
    );
    sender({
      type: 'patch.skills.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: (err as Error).message },
    });
  }
}

// spec/02 § Model catalogue — answer the surface's model-picker request from the
// host's catalogue (Anthropic's model list, read with the Claude OAuth
// credential, cached on a TTL). NO FALLBACK: a credential/upstream failure comes
// back as `ok:false` with the reason, never a hand-maintained list.
export async function handleModelsRequest(
  event: import('@patch/wire').PatchModelsRequestEvent,
  catalog: ModelCatalog,
  sender: (e: WireEvent) => void,
  logger: Logger,
  hostId: string,
  codex?: CodexAccounts,
  endpoints?: ModelEndpointRegistry,
  acp?: AcpRegistry,
): Promise<void> {
  // Every entry names the backend serving it, and a backend that failed is
  // returned as an error AGAINST THAT BACKEND alongside the models that did
  // resolve — a host with an expired credential on one backend still offers the
  // other's models (spec/02 § Model catalogue). NO FALLBACK: a failure is never
  // papered over with a hand-maintained list.
  if (codex) {
    // Each model endpoint is listed under the harness it runs in, and one that
    // cannot be reached is reported against that harness, naming it.
    const sources: Array<{ backend: string; load: Promise<{ id: string; label: string }[]> }> = [
      { backend: CLAUDE_BACKEND_ID, load: catalog.get().then((s) => s.models) },
      { backend: CODEX_BACKEND_ID, load: codex.models() },
      ...(endpoints?.list() ?? []).map((e) => ({
        backend: e.api === 'openai' ? CODEX_BACKEND_ID : CLAUDE_BACKEND_ID,
        load: endpoints!.models(e),
      })),
    ];
    const outcomes = await Promise.allSettled(sources.map((src) => src.load));
    const models: { id: string; label: string; backend: string }[] = [];
    const errors: { backend: string; code: 'upstream'; message: string }[] = [];
    outcomes.forEach((result, index) => {
      const backend = sources[index]!.backend;
      if (result.status === 'fulfilled')
        models.push(...result.value.map((m) => ({ ...m, backend })));
      else errors.push({ backend, code: 'upstream', message: String(result.reason) });
    });
    // Each installed ACP agent offers its models or says, against itself, why not.
    if (acp) {
      const offered = await acp.models();
      models.push(...offered.models.map((m) => ({ ...m, backend: ACP_BACKEND_ID })));
      for (const e of offered.errors)
        errors.push({ backend: ACP_BACKEND_ID, code: 'upstream', message: e.message });
    }
    sender({
      type: 'patch.models.response',
      requestId: event.requestId,
      hostId,
      models,
      errors,
      fetchedAt: new Date().toISOString(),
      ...(event.forSurfaceId ? { forSurfaceId: event.forSurfaceId } : {}),
    });
    return;
  }
  try {
    const snapshot = await catalog.get();
    sender({
      type: 'patch.models.response',
      requestId: event.requestId,
      hostId,
      models: snapshot.models.map((m) => ({ ...m, backend: CLAUDE_BACKEND_ID })),
      errors: [],
      fetchedAt: snapshot.fetchedAt,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, 'patch.models.request: catalogue read failed');
    sender({
      type: 'patch.models.response',
      requestId: event.requestId,
      hostId,
      models: [],
      errors: [
        {
          backend: CLAUDE_BACKEND_ID,
          code: /oauth/i.test(message) ? 'oauth_unavailable' : 'upstream',
          message,
        },
      ],
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  }
}

/**
 * spec/08 § Recurrence — the job editor's natural-language schedule input.
 * Runs the one-shot translator and answers `patch.recurrence.translate.response`.
 * NO FALLBACK: a null from the translator (OAuth miss, SDK error, timeout, or
 * the model's own "UNSURE") becomes `ok:false` with a reason, never a guessed
 * RRULE — the server still re-validates and re-describes whatever comes back
 * `ok:true` before it ever reaches a client (see recurrenceTranslate.ts's header).
 */
export async function handleRecurrenceTranslateRequest(
  event: import('@patch/wire').PatchRecurrenceTranslateRequestEvent,
  translate: (input: {
    requestId: string;
    phrase: string;
    folder: string;
  }) => Promise<string | null>,
  sender: (e: WireEvent) => void,
  logger: Logger,
  hostId: string,
  patchHome: string,
): Promise<void> {
  try {
    const rrule = await translate({
      requestId: event.requestId,
      phrase: event.phrase,
      folder: patchHome,
    });
    if (rrule === null) {
      sender({
        type: 'patch.recurrence.translate.response',
        requestId: event.requestId,
        hostId,
        ok: false,
        error: 'could not confidently translate that phrase into a schedule',
        ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
      });
      return;
    }
    sender({
      type: 'patch.recurrence.translate.response',
      requestId: event.requestId,
      hostId,
      ok: true,
      rrule,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, 'patch.recurrence.translate.request: translation failed');
    sender({
      type: 'patch.recurrence.translate.response',
      requestId: event.requestId,
      hostId,
      ok: false,
      error: message,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  }
}

/**
 * spec/14 § Message links — the Summarise button. Runs the one-shot and answers
 * `patch.link_summary.response`. NO FALLBACK: a null or a throw is `ok:false`
 * with a reason, never an empty summary.
 */
export async function handleLinkSummaryRequest(
  event: import('@patch/wire').PatchLinkSummaryRequestEvent,
  summarise: (input: {
    requestId: string;
    prompt: string;
    url: string;
    text: string;
    folder: string;
  }) => Promise<string | null>,
  sender: (e: WireEvent) => void,
  logger: Logger,
  hostId: string,
  patchHome: string,
): Promise<void> {
  const fail = (error: string): void =>
    sender({
      type: 'patch.link_summary.response',
      requestId: event.requestId,
      hostId,
      ok: false,
      error,
    });
  try {
    const summary = await summarise({
      requestId: event.requestId,
      prompt: event.prompt,
      url: event.url,
      text: event.text,
      folder: patchHome,
    });
    if (summary === null) {
      fail('no account could produce a summary');
      return;
    }
    sender({
      type: 'patch.link_summary.response',
      requestId: event.requestId,
      hostId,
      ok: true,
      summary,
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, 'patch.link_summary.request: summary failed');
    fail(message);
  }
}

/**
 * spec/04 § Browsing (directory listing) — the folder BROWSER. The server asks
 * the host to list a directory's child directories (or, with no `dir`, the
 * browsable roots). The host owns the filesystem and confines listing to its
 * project roots via `FolderRegistry.browse`; a traversal escape / missing dir
 * comes back as `folder_not_found` (NO FALLBACK — never a listing of `/`).
 */
export async function handleFoldersBrowseRequest(
  event: import('@patch/wire').PatchFoldersBrowseRequestEvent,
  folderRegistry: FolderRegistry,
  sender: (e: WireEvent) => void,
  logger: Logger,
  hostId: string,
): Promise<void> {
  try {
    const result = await folderRegistry.browse(event.dir, { create: event.create === true });
    sender({
      type: 'patch.folders.browse.response',
      requestId: event.requestId,
      hostId,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
      ok: true,
      dir: result.dir,
      parent: result.parent,
      entries: result.entries,
    });
  } catch (err) {
    const raw = (err as { code?: string }).code;
    const code =
      raw === 'folder_not_found' || raw === 'still_opening' || raw === 'permission_denied'
        ? raw
        : 'internal';
    if (code === 'internal') {
      // A listing that timed out reaches the surface as `internal` carrying the
      // plain-language message (the wire code set is closed).
      logger.warn(
        { err: (err as Error).message, dir: event.dir },
        'patch.folders.browse.request: list failed',
      );
    }
    sender({
      type: 'patch.folders.browse.response',
      requestId: event.requestId,
      hostId,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * spec/07 § End-to-end voice transport — transcribe a mobile voice-note clip.
 *
 * The server round-trips the uploaded m4a (base64) over the host link; the
 * host runs it through its Whisper backend's "uploaded clip" path (Groq
 * accepts m4a directly; the local faster-whisper backend refuses it with a
 * typed `unsupported_format`) and replies with the transcript or a typed error.
 * The server, on `ok`, injects the transcript as the chat's next user turn.
 * NO FALLBACK — every failure is reported, never swallowed into a blank note.
 */
/**
 * spec/14 & spec/15 § Composer — store an uploaded attachment under the chat's
 * dir so a later `chat.input` carrying its ref can be fed into the turn by path.
 *
 * The server owns the HTTP upload route + a serving-copy for inline rendering;
 * it round-trips the bytes here (base64) because Claude runs on the host and
 * can only read files on the host's filesystem. NO FALLBACK — an unknown chat
 * or a decode/write failure is reported as a typed error, never swallowed.
 */
export function handleAttachmentStore(
  event: import('@patch/wire').PatchAttachmentStoreRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(event.dataBase64, 'base64');
    /* v8 ignore start -- Node's Buffer.from(str, 'base64') never throws for
     * garbage/malformed base64 CONTENT (verified empirically: it just decodes
     * whatever bytes it can) — it only throws when the argument isn't a
     * string at all, which `dataBase64: string` (wire-schema-enforced at the
     * real ingress) rules out. Same defensive-catch pattern already accepted
     * elsewhere in this package (see audio/token-verifier.ts's analogous
     * base64url catch). Kept as a NO FALLBACK safety net, not gamed away. */
  } catch (err) {
    sender({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'invalid_data', message: `bad base64 data: ${(err as Error).message}` },
    });
    return;
  }
  /* v8 ignore stop */
  if (bytes.byteLength === 0) {
    sender({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'invalid_data', message: 'empty attachment' },
    });
    return;
  }
  try {
    const { path } = daemon.storeAttachment({
      chatId: event.chatId,
      id: event.id,
      name: event.name,
      mimeType: event.mimeType,
      kind: event.kind,
      bytes,
    });
    sender({ type: 'patch.attachment.store_response', requestId: event.requestId, ok: true, path });
  } catch (err) {
    const code = err instanceof AttachmentChatNotFoundError ? 'chat_not_found' : 'internal';
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, id: event.id, code },
      'patch.attachment.store_request: store failed',
    );
    sender({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * spec/14 & spec/15 § Composer → Attachments (step 3 of 3) — free a
 * composer-draft attachment the server has already dropped, whose bytes
 * live only on the host (Claude's cwd). Best-effort by design (see
 * `host.deleteAttachment`'s doc): a missing file is already the desired
 * end state, so only an unknown-chat/write failure is reported as a typed
 * error — never swallowed, but never fatal to the caller either.
 */
export function handleAttachmentDelete(
  event: import('@patch/wire').PatchAttachmentDeleteRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  try {
    daemon.deleteAttachment({ chatId: event.chatId, id: event.id, name: event.name });
    sender({ type: 'patch.attachment.delete_response', requestId: event.requestId, ok: true });
  } catch (err) {
    const code = err instanceof AttachmentChatNotFoundError ? 'chat_not_found' : 'internal';
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, id: event.id, code },
      'patch.attachment.delete_request: delete failed',
    );
    sender({
      type: 'patch.attachment.delete_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * One error line per voice surface configured onto a backend whose key this
 * host does not hold. Logged, never thrown: the host keeps serving every
 * chat, and the surface itself is refused per session with the same sentence.
 */
export function logVoiceKeysMissing(
  logger: Logger,
  config: VoiceConfig,
  agent: VoiceAgentSetting,
  keys: VoiceKeys,
): void {
  for (const { surface, backend, env } of voiceSurfacesMissingKey(config, agent, keys)) {
    logger.error(
      { surface, backend, missingKey: env },
      `voice: ${voiceKeyMissingMessage(surface, backend)} Its sessions will be refused.`,
    );
  }
}

export async function handleVoiceNoteTranscribe(
  event: import('@patch/wire').PatchVoiceNoteTranscribeRequestEvent,
  transcribers: DictationTranscribers | undefined,
  engine: DictationEngine,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  if (!transcribers) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: {
        code: 'internal',
        message: 'host audio stack not ready — whisper backend unavailable',
      },
    });
    return;
  }
  let audio: Buffer;
  try {
    audio = Buffer.from(event.audioBase64, 'base64');
    /* v8 ignore start -- same reasoning as handleAttachmentStore's identical
     * catch above: Buffer.from(str, 'base64') never throws for malformed
     * base64 content, only for a non-string argument, which `audioBase64:
     * string` rules out at the wire boundary. Defensive NO FALLBACK net, not
     * a coverage gap. */
  } catch (err) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: `bad base64 audio: ${(err as Error).message}` },
    });
    return;
  }
  /* v8 ignore stop */
  // spec/07 § Dictation engines: the engine chosen for the uploading surface
  // reads the clip. Deepgram with no key on this host is refused, not quietly
  // transcribed by Whisper instead (NO SILENT FALLBACK). A tidy-up pass asks
  // for Whisper by name: that IS the engine it chose.
  if ((event.engine ?? engine) === 'local') {
    // Parakeet on this computer is run by the desktop app, never by a host.
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: {
        code: 'transcription_failed',
        message:
          'Dictation is set to Parakeet on this computer, which only runs in the desktop app. Switch Dictation to another engine in Settings → Dictation.',
      },
    });
    return;
  }
  const picked = pickDictationTranscriber(event.engine ?? engine, transcribers);
  if (!picked.ok) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'voice_key_missing', message: picked.message },
    });
    return;
  }
  const whisper = picked.whisper;
  if (audio.byteLength === 0) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'transcription_failed', message: 'empty audio clip' },
    });
    return;
  }
  try {
    const transcript = await whisper.transcribeClip(audio, event.format);
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: true,
      transcript,
    });
  } catch (err) {
    const code =
      err instanceof UnsupportedClipFormatError ? 'unsupported_format' : 'transcription_failed';
    logger.warn(
      { err: (err as Error).message, format: event.format, code },
      'patch.voice_note.transcribe_request: transcription failed',
    );
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

export class TurnModelUnavailableError extends Error {}

/**
 * Dictation mode's end-of-turn check (spec/07 § Dictation mode): the clip so
 * far → Smart Turn's probability that the speaker has finished. Every failure
 * is answered with its reason; nothing is dropped.
 */
export async function handleTurnCheck(
  event: import('@patch/wire').PatchVoiceTurnCheckRequestEvent,
  loadDetector: () => Promise<TurnDetector>,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  const fail = (
    code: 'unsupported_format' | 'model_unavailable' | 'internal',
    message: string,
  ): void => {
    logger.warn({ code, err: message }, 'patch.voice.turn_check_request: failed');
    sender({
      type: 'patch.voice.turn_check_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message },
    });
  };
  let pcm: Int16Array;
  try {
    pcm = pcmFromWav(Buffer.from(event.audioBase64, 'base64'));
  } catch (err) {
    fail('unsupported_format', (err as Error).message);
    return;
  }
  let detector: TurnDetector;
  try {
    detector = await loadDetector();
  } catch (err) {
    fail('model_unavailable', (err as Error).message);
    return;
  }
  try {
    const probability = Math.min(1, Math.max(0, await detector.probability(pcm)));
    sender({
      type: 'patch.voice.turn_check_response',
      requestId: event.requestId,
      ok: true,
      probability,
    });
  } catch (err) {
    fail('internal', (err as Error).message);
  }
}

/**
 * spec/15 § Secrets: apply a surface-originated secret write to the host-owned
 * store and ack it on the same peer. On success also publish `secrets.updated`
 * so every mirror + surface reflects the write immediately. A set with an
 * invalid key is rejected (`invalid_key`); deleting an absent key is
 * `not_found`. NO FALLBACK — an unexpected fs error is reported as `internal`,
 * never swallowed.
 */
export function handleSecretsMutation(
  event:
    | import('@patch/wire').PatchSecretsSetRequestEvent
    | import('@patch/wire').PatchSecretsDeleteRequestEvent,
  store: SecretsStore,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  try {
    if (event.type === 'patch.secrets.set_request') {
      store.set(event.key, event.value);
    } else {
      const removed = store.delete(event.key);
      if (!removed) {
        sender({
          type: 'patch.secrets.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_found', message: `secret not found: ${event.key}` },
        });
        return;
      }
    }
    sender({ type: 'patch.secrets.response', requestId: event.requestId, ok: true });
    sender({ type: 'secrets.updated', secrets: store.list() });
  } catch (err) {
    if (err instanceof InvalidSecretKeyError) {
      sender({
        type: 'patch.secrets.response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'invalid_key', message: err.message },
      });
      return;
    }
    logger.warn(
      { err: (err as Error).message, key: event.key },
      `${event.type}: secret write failed`,
    );
    sender({
      type: 'patch.secrets.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: (err as Error).message },
    });
  }
}

export async function handleFilesRequest(
  event: import('@patch/wire').PatchFilesRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  const { resolve: pathResolve, join, sep, relative } = await import('node:path');
  const state = daemon.chatState.get(event.chatId);
  if (!state) {
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'chat_not_found', message: `chat not found: ${event.chatId}` },
    });
    return;
  }
  const root = pathResolve(state.folder);
  const rel = (event.path ?? '').replace(/^\/+/, '');
  const target = pathResolve(join(root, rel));
  if (target !== root && !target.startsWith(root + sep)) {
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'path_escape', message: 'path escapes chat folder' },
    });
    return;
  }

  // Group 20 fix #5: file content fetch.
  if (event.content === true) {
    // G3: `ref: 'head'` returns the git HEAD blob (for "view diff vs HEAD").
    // G3-d1 (NO FALLBACK): if the chat folder is not a git work-tree, or has no
    // HEAD commit, there is NO baseline to diff against. We must NOT silently
    // return an empty baseline — that masks the missing git history and makes
    // the diff editor render the whole file as a brand-new addition. Instead we
    // reject loudly with `no_head_baseline` (→ 409 at the HTTP boundary). A file
    // that IS in a git repo with a HEAD but is merely untracked still yields an
    // empty string (genuinely no prior committed content — that is the truth,
    // not a fallback).
    if (event.ref === 'head') {
      // First establish that there is a HEAD baseline at all. `git rev-parse
      // --verify HEAD` fails on a non-git folder OR a repo with no commits yet.
      let hasHead = false;
      try {
        if (!isInsideGitWorkTree(root)) throw new Error('not a work tree');
        execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
          cwd: root,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        hasHead = true;
      } catch {
        hasHead = false;
      }
      if (!hasHead) {
        sender({
          type: 'patch.files.response',
          requestId: event.requestId,
          ok: false,
          error: {
            code: 'no_head_baseline',
            message: 'chat folder is not a git work-tree with a HEAD commit',
          },
        });
        return;
      }
      let head = '';
      try {
        head = execFileSync('git', ['show', `HEAD:./${rel}`], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        });
      } catch {
        // Repo has a HEAD but this path is untracked / not in HEAD → genuinely
        // empty baseline (the file has no committed prior content).
        head = '';
      }
      sender({
        type: 'patch.files.response',
        requestId: event.requestId,
        ok: true,
        path: rel,
        content: head,
        size: Buffer.byteLength(head, 'utf8'),
      });
      return;
    }
    try {
      const stat = statSync(target);
      if (!stat.isFile()) {
        // G3-d3: requesting file content of a directory is a client error, not
        // a bad-gateway condition. Report `not_a_file` (→ 400).
        sender({
          type: 'patch.files.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_a_file', message: 'path is a directory, not a file' },
        });
        return;
      }
      // Editor overhaul (binary preview): `encoding: 'base64'` reads the file
      // as raw bytes rather than decoding as UTF-8 — the working-tree text
      // path (no `encoding`) is unchanged, this is purely additive. Backs
      // `GET /api/chats/:id/files/raw` (images/PDF), which needs the actual
      // bytes, not whatever UTF-8 decoding does to a PNG.
      const content =
        event.encoding === 'base64'
          ? readFileSync(target).toString('base64')
          : readFileSync(target, 'utf8');
      sender({
        type: 'patch.files.response',
        requestId: event.requestId,
        ok: true,
        path: rel,
        content,
        size: stat.size,
      });
      return;
    } catch (err) {
      // G3-d2: a missing path is a client-side not-found. Report it as
      // `not_found` (→ 404) with a SANITIZED message that does NOT leak the
      // absolute host filesystem path. Only the chat-relative path is echoed.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        sender({
          type: 'patch.files.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_found', message: `no such file: ${rel}` },
        });
        return;
      }
      sender({
        type: 'patch.files.response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'internal', message: `failed to read file: ${rel}` },
      });
      return;
    }
  }

  // Group 20 fix #5: recursive walk for project-wide ⌘P. Editor overhaul
  // (hierarchical tree): this is now ALSO the single source the file browser
  // builds its whole nested tree from client-side (`buildFileTree` in
  // EditorRail.tsx), so directories are listed too, not just files — without
  // that, an empty directory (or one the user hasn't yet opened a file
  // inside) could never appear as a row to expand. Dotfiles are included for
  // the same reason the non-recursive listing below includes them: the
  // browser is for poking around the whole repo, and `.env.local` /
  // `.claude/skills/...` are exactly the kind of thing someone opens it to
  // find — the old "skip dotfiles as ⌘P search noise" behaviour no longer
  // makes sense now this walk also backs the visible tree, not only ⌘P.
  if (event.recursive === true) {
    const cap = event.maxEntries ?? 5000;
    // `listFilesRecursive` (files-recursive.ts) is now the hierarchical
    // tree's ONLY data source, not just ⌘P's — async (never blocks the
    // host's event loop), gitignore-aware via `git ls-files`, and cached.
    // It returns bare {name,type} pairs; dirty-state is layered on here,
    // exactly like the non-recursive listing below, so the pending-dot
    // marker works at any depth in the tree, not only inside whichever
    // single directory used to be "current".
    const rawEntries = await listFilesRecursive(root, cap);
    const dirtyPaths = daemon.dirtyFilePaths(event.chatId);
    const gitDirtyRel = await gitDirtyPaths(root);
    const flat: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }> = rawEntries.map(
      (e) => {
        if (e.type !== 'file') return e;
        const abs = join(root, e.name);
        const dirty = dirtyPaths.has(abs) || gitDirtyRel.has(e.name);
        return dirty ? { ...e, dirty: true } : e;
      },
    );
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: true,
      path: rel,
      entries: flat,
    });
    return;
  }

  try {
    const dirents = readdirSync(target, { withFileTypes: true });
    // Group 20 fix #5: mark files dirty if there's an in-flight permission_request
    // proposing to edit them.
    const dirtyPaths = daemon.dirtyFilePaths(event.chatId);
    // G3-d3: the green ● must reflect an ACTUAL on-disk pending change, NOT
    // merely that the agent referenced/edited the file earlier in the chat. The
    // authoritative source is the git work-tree: a file whose working-tree
    // content differs from its committed baseline (modified or untracked) is
    // genuinely dirty; a file the agent edited but whose content now matches
    // HEAD is NOT. Compute the set of git-dirty paths (relative to the work-tree
    // root) once for this listing. A non-git folder yields an empty set (no
    // baseline to diff against → only pending permissions mark a file dirty).
    const gitDirtyRel = await gitDirtyPaths(root);
    // Dotfiles ARE listed here — the file browser is for poking around the
    // whole repo, and a hidden config file (`.env.local`, etc.) is exactly
    // the kind of thing someone opens the browser to find. (Editor overhaul:
    // this single-directory listing is no longer called by the web client at
    // all — the hierarchical tree and ⌘P both read `recursive: true` only —
    // left in place as it costs nothing dead, but don't extend it.)
    const entries = dirents.map((d) => {
      if (d.isDirectory()) return { name: d.name, type: 'dir' as const };
      const abs = join(target, d.name);
      const size = statSync(abs).size;
      const relToRoot = relative(root, abs);
      const dirty = dirtyPaths.has(abs) || gitDirtyRel.has(relToRoot);
      return {
        name: d.name,
        type: 'file' as const,
        size,
        ...(dirty ? { dirty: true } : {}),
      };
    });
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: true,
      path: rel,
      entries,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, path: rel },
      'patch.files.request: list failed',
    );
    // Sanitize: do not leak the absolute host path in the wire/HTTP message.
    const code = (err as NodeJS.ErrnoException).code;
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: false,
      error:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? { code: 'not_found', message: `no such directory: ${rel || '.'}` }
          : { code: 'internal', message: `failed to list directory: ${rel || '.'}` },
    });
  }
}

/**
 * Server asked to create / rename / delete one path inside a chat's folder
 * (REST `POST /api/chats/:id/files` → spec/03 § Files). The host owns the
 * filesystem, so it owns both the guard and the answer: every refusal comes
 * back as a typed code the surface shows the user, and nothing is ever
 * silently skipped.
 */
export function handleFileOpRequest(
  event: import('@patch/wire').PatchFileOpRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): void {
  const outcome = daemon.fileOp({
    chatId: event.chatId,
    op: event.op,
    path: event.path,
    ...(event.to !== undefined ? { to: event.to } : {}),
  });
  sender(
    outcome.ok
      ? {
          type: 'patch.file_op.response',
          requestId: event.requestId,
          ok: true,
          path: outcome.path,
        }
      : {
          type: 'patch.file_op.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/** spec/14 § Document editor, step 2 of 3: the doc view (mode, suggestions, threads, versions). */
export function handleDocRequest(
  event: import('@patch/wire').PatchDocRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): void {
  const outcome = daemon.getDocView(event.chatId, event.path);
  sender(
    outcome.ok
      ? { type: 'patch.doc.response', requestId: event.requestId, ok: true, view: outcome.value }
      : {
          type: 'patch.doc.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/**
 * spec/14 § Document editor, step 2 of 3: every surface-facing mutation —
 * mode switch, accept/reject (one or all), comment/reply/resolve, restore —
 * dispatched by `action.op` to the matching `Daemon` method, each already
 * shaped as `{ok:true, value}|{ok:false, code, message}`.
 */
export function handleDocActionRequest(
  event: import('@patch/wire').PatchDocActionRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): void {
  const { chatId, path, action } = event;
  const outcome =
    action.op === 'set_mode'
      ? daemon.setDocMode(chatId, path, action.mode)
      : action.op === 'accept_suggestion'
        ? daemon.acceptDocSuggestion(chatId, path, action.id)
        : action.op === 'reject_suggestion'
          ? daemon.rejectDocSuggestion(chatId, path, action.id)
          : action.op === 'accept_all'
            ? daemon.acceptAllDocSuggestions(chatId, path)
            : action.op === 'reject_all'
              ? daemon.rejectAllDocSuggestions(chatId, path)
              : action.op === 'add_comment'
                ? daemon.addDocComment(chatId, path, action.anchor, action.text)
                : action.op === 'reply_comment'
                  ? daemon.replyDocComment(chatId, path, action.threadId, action.text)
                  : action.op === 'resolve_comment'
                    ? daemon.resolveDocThread(chatId, path, action.threadId, action.resolved)
                    : daemon.restoreDocVersion(chatId, path, action.versionId);
  sender(
    outcome.ok
      ? {
          type: 'patch.doc_action.response',
          requestId: event.requestId,
          ok: true,
          view: outcome.value,
        }
      : {
          type: 'patch.doc_action.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/** spec/14 § Document editor, step 3 of 3 — opening a `.docx` converts it to the `.md` the editor actually opens. */
export async function handleDocConvertRequest(
  event: import('@patch/wire').PatchDocConvertRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): Promise<void> {
  const outcome = await daemon.convertDocx(event.chatId, event.path);
  sender(
    outcome.ok
      ? {
          type: 'patch.doc_convert.response',
          requestId: event.requestId,
          ok: true,
          mdPath: outcome.value.mdPath,
          warnings: outcome.value.warnings,
          reused: outcome.value.reused,
        }
      : {
          type: 'patch.doc_convert.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/** spec/14 § Document editor, step 3 of 3 — Download/Save as .docx/.pdf/.md from the editor's menu. */
export async function handleDocExportRequest(
  event: import('@patch/wire').PatchDocExportRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): Promise<void> {
  const outcome = await daemon.exportDoc(event.chatId, event.path, event.format);
  sender(
    outcome.ok
      ? {
          type: 'patch.doc_export.response',
          requestId: event.requestId,
          ok: true,
          path: outcome.value.path,
          mimeType: outcome.value.mimeType,
          dataBase64: outcome.value.buffer.toString('base64'),
          warnings: outcome.value.warnings,
        }
      : {
          type: 'patch.doc_export.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/**
 * A server's request to retire this host's old copy of a chat that a move
 * before linked chats took over (spec/04 § Moving to another host). Every
 * outcome is answered, so a refusal comes back as a refusal, not as silence.
 */
/** spec/11 § Replacing a host: the asked folders that are not a directory here. */
export function answerFoldersCheck(
  event: import('@patch/wire').PatchFoldersCheckRequestEvent,
  hostId: string,
): import('@patch/wire').PatchFoldersCheckResponseEvent {
  const missing = event.folders.filter((folder) => {
    try {
      return !statSync(folder).isDirectory();
    } catch {
      return true;
    }
  });
  return { type: 'patch.folders_check.response', requestId: event.requestId, hostId, missing };
}

/**
 * spec/11 § Replacing a host: take over each chat, continuing from the server's
 * high-water mark. One chat that cannot be taken is named with why; the rest
 * still come.
 */
export function answerChatAdopt(
  event: import('@patch/wire').PatchChatAdoptRequestEvent,
  daemon: Daemon,
  logger: Logger,
  hostId: string,
): import('@patch/wire').PatchChatAdoptResponseEvent {
  const adopted: string[] = [];
  const refused: Array<{ chatId: string; message: string }> = [];
  for (const chat of event.chats) {
    try {
      daemon.adoptChat(chat);
      adopted.push(chat.chatId);
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ chatId: chat.chatId, err: message }, 'replace host: chat not taken over');
      refused.push({ chatId: chat.chatId, message });
    }
  }
  logger.info(
    { adopted: adopted.length, refused: refused.length },
    'replace host: chats taken over',
  );
  return {
    type: 'patch.chat_adopt.response',
    requestId: event.requestId,
    hostId,
    adopted,
    refused,
  };
}

export function handleChatMoveRequest(
  event: import('@patch/wire').PatchChatMoveRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
  hostId: string,
): void {
  const base = {
    type: 'patch.chat_move.response' as const,
    requestId: event.requestId,
    hostId,
    chatId: event.chatId,
    op: event.op,
  };
  try {
    // A server only asks one thing any more: retire an old copy a move before
    // linked chats left here (spec/04 § Moving to another host).
    if (event.op === 'retire' && event.force === true) {
      // Stopping running work takes a moment: answer when done.
      void daemon
        .retireTakenOverChat(event.chatId)
        .then(() => sender({ ...base, ok: true }))
        .catch(refuse);
      return;
    }
    throw new ChatMoveError(
      'unsupported',
      `this host no longer copies chats between hosts (${event.op}); moving starts a new linked chat`,
    );
  } catch (err) {
    refuse(err);
  }
  function refuse(err: unknown): void {
    const code = err instanceof ChatMoveError ? err.code : 'internal';
    const message = (err as Error).message;
    logger.warn({ op: event.op, chatId: event.chatId, code, err: message }, 'chat move refused');
    sender({ ...base, ok: false, error: { code, message } });
  }
}

/**
 * spec/10 § Backend credentials — multiple accounts: the store-reading bits
 * `handleServerEvent` needs but cannot close over itself (it's a standalone
 * exported function, deliberately testable without the whole boot
 * scaffolding — see the module doc above). Omitted entirely by existing unit
 * tests that construct their own `Daemon` and never touch a real store; the
 * account-aware branches below degrade to "no store wiring" in that case.
 */
export interface AccountReportHelpers {
  buildAccountReport: (activeOverride?: {
    connected: boolean;
  }) => import('@patch/wire').HostAccountEvent;
  /** The shared account ids this host holds for a model's backend, read now. */
  heldAccounts: (model: string | undefined) => string[];
  /** Meeting mode; absent in tests that do not exercise it. */
  meetings?: MeetingManager | undefined;
  /** True once a speech route is set up on this host (spec/02 § Speech set-up). */
  speechSetUp?: (() => boolean) | undefined;
}

/**
 * Translate inbound server WS frames (originally surface events) into Host
 * action calls. `sender` is bound to *this* server peer — for replay events we
 * route the streamed events back through it (per-surface) rather than the
 * fan-out `emit`.
 */
/**
 * A meeting needs speech-to-text and this host has none set up. Never answered
 * with a stub: the surface offers the two routes (a cloud speech key, or the
 * local voice models) and the user picks.
 */
class SpeechNotSetUpError extends Error {
  constructor() {
    super(
      'Meetings need speech-to-text and none is set up on this host. Add a speech API key in Settings → Providers, or download the local voice models in Settings → Hosts.',
    );
  }
}

function requireMeetings(accounts: AccountReportHelpers | undefined): MeetingManager {
  if (!accounts?.meetings) throw new Error('meeting mode is not available on this host');
  return accounts.meetings;
}

export async function handleServerEvent(
  event: WireEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
  accounts?: AccountReportHelpers,
): Promise<void> {
  // op label for log structure (m9): every rejection log line now carries
  // {op, chatId, errorCode}.
  const op = event.type;
  const evChatId =
    'chatId' in event && typeof (event as { chatId?: unknown }).chatId === 'string'
      ? (event as { chatId: string }).chatId
      : undefined;
  try {
    switch (event.type) {
      case 'chat.spawn_request': {
        // A host with no usable backend credential cannot run the turn it is
        // being asked to run. Spawning anyway emitted `chat.spawned`, which the
        // server settles as a run status of `ok` — so the inbound log claimed
        // success for a turn that never happened, with a chat link to nothing.
        // spec/08 § Logs names exactly this case `dispatch-error`. Refuse here,
        // before the chat exists, so the refusal reaches the run log as one.
        // Re-read the credential rather than trusting the boot-time snapshot:
        // a `claude login` since boot must be picked up without a restart.
        // Which key answers is the host's business — the first stored one with
        // credit (spec/10 § Backend credentials); a spawn cannot name one.
        const spawnAuth = await daemon.backendCredential(event.model, event.preferredAccountId);
        // Refused for a reason that is not a sign-in — no account may run it,
        // or the one it names is on another host: said in those words, and the
        // host is not reported as signed out.
        if (!spawnAuth.ok && spawnAuth.code !== undefined && spawnAuth.limit === undefined) {
          logger.warn(
            { op, folder: event.folder, reason: spawnAuth.reason },
            'chat.spawn_request refused',
          );
          sender({
            type: 'chat.error',
            chatId: event.chatId ?? 'pending-spawn',
            error: { code: spawnAuth.code, message: spawnAuth.reason },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        // An account at its cap is not a missing credential: the chat is made
        // and its first turn pauses on the cap like any other (spec/10 § Spending caps).
        if (!spawnAuth.ok && spawnAuth.limit === undefined) {
          const spawnProvider = providerDescriptor(providerForModel(event.model));
          const host = daemon.hostId;
          sender({
            type: 'host.unauthenticated',
            hostId: host,
            backendId: spawnProvider.backendId,
            reason: spawnAuth.reason,
          });
          // CORRECT THE SELF-REPORT. `connected` was computed once at boot, so a
          // credential that expired since left every surface believing this
          // host was signed in — no banner, no warning, and a composer that
          // looked ready right up until the send failed. Say what is true now.
          // The refusal means the host could not produce a usable key at all —
          // it resolves them in order and takes the first that works — so it is
          // the host that is disconnected, not one row of it.
          const report: import('@patch/wire').HostAccountEvent =
            accounts && HARNESS_TRAITS[providerForModel(event.model)].buildsAccountReport
              ? accounts.buildAccountReport({ connected: false })
              : {
                  type: 'host.account',
                  hostId: host,
                  backendId: spawnProvider.backendId,
                  connected: false,
                  accountEmail: null,
                };
          sender(report);
          logger.error(
            { op, folder: event.folder, reason: spawnAuth.reason },
            'chat.spawn_request refused: no backend credential on this host',
          );
          sender({
            type: 'chat.error',
            chatId: event.chatId ?? 'pending-spawn',
            error: {
              code: spawnProvider.loginRequiredCode as ChatErrorCode,
              // Short and actionable. This lands in a toast and in the chat, so
              // dumping the provider's raw OAuth JSON at a person tells them
              // nothing they can act on — the reason goes to the log instead.
              message: `${spawnProvider.accountsKey === null ? spawnAuth.reason : `${host} isn't signed in to ${spawnProvider.label}. Sign in from Settings → Hosts.`}`,
            },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        // spec/10 § Backend credentials — preferred account. Only an account
        // this host holds for the chat's own backend: a preference that silently
        // meant nothing would be a setting that lies.
        if (event.preferredAccountId !== undefined) {
          const held = accounts?.heldAccounts(event.model) ?? [];
          if (!held.includes(event.preferredAccountId)) {
            const problem = `preferred account ${event.preferredAccountId} is not one of ${daemon.hostId}'s ${providerDescriptor(providerForModel(event.model)).label} accounts (holds: ${held.join(', ') || 'none'})`;
            logger.error({ op, folder: event.folder }, `chat.spawn_request refused: ${problem}`);
            sender({
              type: 'chat.error',
              chatId: event.chatId ?? 'pending-spawn',
              error: { code: 'account_not_found', message: problem },
              seq: OUT_OF_BAND_SEQ,
            });
            return;
          }
        }
        const spawnedChatId = await daemon.spawnChat({
          folder: event.folder,
          ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
          ...(event.localId !== undefined ? { localId: event.localId } : {}),
          // spec/04 § Hidden. `archived` is what a server predating the rename
          // sends for the same intent — keep the run out of the inbox — and a
          // spawn is never archived any more (archived means stopped).
          ...(event.hidden === true || event.archived === true ? { hidden: true } : {}),
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
          ...(event.preferredAccountId !== undefined
            ? { preferredAccountId: event.preferredAccountId }
            : {}),
        });
        // spec/04 § Goals, spec/08 ## Action — a job's `spawn`/`continue`
        // action can set the new chat's goal at creation, before its first
        // turn runs.
        if (event.goal !== undefined) {
          await daemon.setGoal(spawnedChatId, event.goal).catch((err: unknown) => {
            logger.warn({ op, chatId: spawnedChatId, err }, 'chat.spawn_request: setGoal failed');
          });
        }
        // spec/02 § Self-wake, spec/08 ## Action — a job's own loop prompt,
        // armed once at creation on the same scheduler `/loop` reaches.
        if (event.loop !== undefined) {
          try {
            daemon.scheduleWake(spawnedChatId, {
              message: event.loop.message,
              every: event.loop.every,
            });
          } catch (err) {
            logger.error({ op, chatId: spawnedChatId, err }, 'chat.spawn_request: loop failed');
          }
        }
        return;
      }
      case 'chat.input': {
        // spec/06 ## Speakers thread: each inbound audio turn from a physical
        // voice device is tagged `[voice • device]` with its deviceId so the
        // agent knows which device it's hearing from. Only the voice-device
        // ingress hook attaches a `voice-device` source on this server→host
        // path; voice-app turns carry their own tags elsewhere.
        await daemon.sendInput(chatInputToSendOptions(event));
        return;
      }
      case 'hook.agent_response_outcome': {
        // spec/20-hooks.md § On the agent's response — the server's answer
        // to this host's own `hook.agent_response_check_request`; the host
        // decides what each result means (resubmit, defer, log).
        daemon.handleHookAgentResponseOutcome(event);
        return;
      }
      case 'chat.stop_request': {
        // spec/04 § Branching — a branch-addressed stop ends just that
        // branch's turn; the plain (no branchId) form is "stop THE CHAT",
        // which ends every branch's turn. Only where the provider declares
        // interrupt (spec/02 § Provider adapters).
        if (daemon.refuseUnlessCapable(event.chatId, 'interrupt')) return;
        if (event.branchId !== undefined) daemon.stopBranch(event.chatId, event.branchId);
        else await daemon.stopAllBranches(event.chatId);
        return;
      }
      case 'chat.continue_request': {
        // spec/12 § Continue — the user pressed Continue on an interrupted turn
        // (or the setting did it for them). A visible message, sent like any
        // other.
        await daemon.continueChat(event.chatId);
        return;
      }
      case 'chat.tool_cancel_request': {
        await daemon.cancelToolCall(event.chatId, event.callId);
        return;
      }
      case 'chat.held_input_expired': {
        // spec/12 § Host-offline UX — a message the server held for this host
        // while it was away expired undelivered. Recorded in the chat, by the
        // chat's own writer, so it stays in the record.
        daemon.recordHeldInputExpired(event.chatId, event.text, event.hostName);
        return;
      }
      case 'chat.resume_now_request': {
        // spec/10 § Usage: stop waiting out the limit and try now. Logged
        // either way — "I pressed it and nothing happened" has to be
        // answerable from the log.
        const resumed = daemon.resumeRateLimitedNow(event.chatId);
        logger.info({ chatId: event.chatId, resumed }, 'manual resume from a usage-limit pause');
        return;
      }
      case 'chat.unqueue_request': {
        // spec/04 ## Message queueing: cancel a still-pending queued turn.
        daemon.unqueueInput(event.chatId, event.localId);
        return;
      }
      case 'chat.edit_queued_request': {
        // spec/04 ## Message queueing § Edit: replace a still-pending queued
        // turn's typed text in place.
        daemon.editQueuedInput(event.chatId, event.localId, event.message);
        return;
      }
      case 'chat.promote_request': {
        // spec/04 ## Message queueing: interrupt the running turn so the
        // queue starts draining now. Does not reorder the queue.
        await daemon.promoteInput(event.chatId, event.localId);
        return;
      }
      case 'chat.fork_request': {
        // spec/04 § Branching: edit a user turn — fork a new track from it.
        await daemon.forkChat({
          chatId: event.chatId,
          seq: event.seq,
          message: event.message,
          localId: event.localId,
          ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
          ...(event.disabledTools !== undefined ? { disabledTools: event.disabledTools } : {}),
        });
        return;
      }
      case 'chat.side_request': {
        // spec/04 § Side threads: a side message off this turn — its own track,
        // sharing the prefix up to and including it.
        await daemon.sideChat({
          chatId: event.chatId,
          seq: event.seq,
          message: event.message,
          localId: event.localId,
        });
        return;
      }
      case 'chat.branch_switch_request': {
        // spec/04 § Branching: make that track the active one.
        await daemon.switchBranch(event.chatId, event.branchId);
        return;
      }
      case 'chat.branch_rename_request': {
        // spec/04 § Branching — "Side branches get a name … renameable".
        daemon.renameBranch(event.chatId, event.branchId, event.name);
        return;
      }
      case 'chat.send_back_request': {
        // spec/04 § Send back; spec/14 § Side threads panel — "Send back to
        // chat" button. Same effect as the agent's own `patch_send_back`
        // tool, triggered directly by the surface instead.
        const result = await daemon.sendBackToParent(event.chatId, event.branchId);
        if (!result.ok) {
          sender({
            type: 'chat.error',
            chatId: event.chatId,
            error: { code: 'send_back_failed', message: result.error },
            seq: OUT_OF_BAND_SEQ,
          });
        }
        return;
      }
      case 'chat.resume_request': {
        await daemon.resumeChat(event.chatId);
        return;
      }
      case 'meeting.get_request': {
        accounts?.meetings?.publish(event.chatId);
        return;
      }
      case 'meeting.control_request': {
        const m = requireMeetings(accounts);
        if (event.action === 'start') {
          if (accounts?.speechSetUp && !accounts.speechSetUp()) throw new SpeechNotSetUpError();
          m.start(event.chatId, event.settings);
        } else if (event.action === 'tune') {
          if (!event.settings) throw new Error('meeting tune needs settings');
          m.tune(event.chatId, event.settings);
        } else if (event.action === 'name_voice') {
          if (event.voice === undefined || event.name === undefined)
            throw new Error('meeting name_voice needs voice and name');
          m.nameVoice(event.chatId, event.voice, event.name);
        } else if (event.action === 'pause') m.pause(event.chatId);
        else if (event.action === 'resume') m.resume(event.chatId);
        else if (event.action === 'delete') await m.delete(event.chatId);
        else await m.end(event.chatId);
        return;
      }
      case 'meeting.audio': {
        await requireMeetings(accounts).ingestAudio(
          event.chatId,
          event.source,
          Buffer.from(event.audioBase64, 'base64'),
          event.speakerName,
          event.device,
        );
        return;
      }
      case 'meeting.action_request': {
        const m = requireMeetings(accounts);
        const given = [
          event.decision,
          event.owner,
          event.agentRuns,
          event.assign,
          event.title,
          event.add,
        ].filter((x) => x !== undefined).length;
        if (given !== 1)
          throw new Error(
            'meeting.action_request needs exactly one of decision, owner, assign, title, add, agentRuns',
          );
        if (event.agentRuns !== undefined || event.add !== undefined) {
          if (event.actionId !== undefined)
            throw new Error('meeting.action_request agentRuns and add take no actionId');
          if (event.add !== undefined) m.addAction(event.chatId, event.add);
          else m.setAgentRunsActions(event.chatId, event.agentRuns === true);
          return;
        }
        if (event.actionId === undefined)
          throw new Error('meeting.action_request needs an actionId');
        if (event.owner !== undefined) m.setActionOwner(event.chatId, event.actionId, event.owner);
        else if (event.assign !== undefined)
          m.assignAction(event.chatId, event.actionId, event.assign);
        else if (event.title !== undefined)
          m.setActionTitle(event.chatId, event.actionId, event.title);
        else if (event.decision !== undefined)
          await m.decide(event.chatId, event.actionId, event.decision);
        return;
      }
      case 'meeting.notes_request': {
        requireMeetings(accounts).editNotes(event.chatId, event.edit);
        return;
      }
      case 'meeting.research_request': {
        requireMeetings(accounts).setResearch(event.chatId, event.on);
        return;
      }
      case 'meeting.writeup_request': {
        const m = requireMeetings(accounts);
        if ((event.writeup === undefined) === (event.regenerate === undefined))
          throw new Error('meeting.writeup_request needs exactly one of writeup, regenerate');
        if (event.writeup !== undefined) m.setWriteup(event.chatId, event.writeup);
        else await m.regenerateWriteup(event.chatId);
        return;
      }
      case 'meeting.my_notes_request': {
        requireMeetings(accounts).setMyNotes(event.chatId, event.text);
        return;
      }
      case 'chat.question_activity': {
        daemon.noteQuestionActivity(event.chatId);
        return;
      }
      case 'chat.pin_request': {
        await daemon.setPinned(event.chatId, event.pinned);
        return;
      }
      case 'chat.archive_request': {
        await daemon.setArchived(event.chatId, event.archived);
        return;
      }
      case 'chat.disable_request': {
        await daemon.setDisabled(event.chatId, event.disabled);
        return;
      }
      case 'chat.rotate_request': {
        // Fire-and-forget from the server's scheduler (spec/06 § Session
        // rotation) — a refusal (mid-turn, no digest generator, digest
        // failure) is the host's own NO FALLBACK guard, logged and dropped
        // rather than propagated, since there is no request-side connection
        // waiting on an answer.
        try {
          await daemon.rotateThread(event.chatId, event.carry === false ? { carry: false } : {});
        } catch (err) {
          logger.warn(
            { chatId: event.chatId, err: (err as Error).message },
            'chat.rotate_request: rotation refused',
          );
        }
        return;
      }
      case 'manager.finished_run': {
        // Fire-and-forget from the server (spec/06 § Finished chats) — the
        // result goes back over the SAME link, never blocking the sender.
        sender(await daemon.deliverFinishedChats(event));
        return;
      }
      case 'chat.snooze_request': {
        // spec/04 § Snooze — absolute wake time, or null to unsnooze.
        await daemon.setSnoozed(event.chatId, event.snoozedUntil, {
          ...(event.setId !== undefined ? { setId: event.setId } : {}),
          ...(event.waitForSet === true ? { waitForSet: true } : {}),
        });
        return;
      }
      case 'chat.snooze_back_clear_request': {
        // spec/04 § Snooze → Back — the user opened a chat that came back.
        daemon.clearSnoozeBack(event.chatId);
        return;
      }
      case 'chat.ask_done_request': {
        // spec/04 § Current status — the user did what `patch_ask_human` asked.
        await daemon.resolveAsk(event.chatId, 'user');
        return;
      }
      case 'chat.hide_request': {
        // spec/04 § Hidden — `false` is the Hidden section's Show.
        await daemon.setHidden(event.chatId, event.hidden);
        return;
      }
      case 'chat.delete_request': {
        await daemon.setDeleted(event.chatId, event.deleted);
        return;
      }
      case 'chat.goal_request': {
        await daemon.setGoal(event.chatId, event.goal, {
          ...(event.then !== undefined ? { then: event.then } : {}),
          ...(event.remindEvery !== undefined ? { remindEvery: event.remindEvery } : {}),
          ...(event.checkInEvery !== undefined ? { checkInEvery: event.checkInEvery } : {}),
        });
        return;
      }
      case 'chat.todos_request': {
        // spec/02 § Task list — a surface rewrote the list; adopt it wholesale.
        daemon.setTodos(event.chatId, event.todos);
        return;
      }
      case 'chat.rename_request': {
        // spec/04 § Name — a user-chosen name, or null to go back to derived.
        await daemon.setName(event.chatId, event.name);
        return;
      }
      case 'chat.reminder_request': {
        await daemon.setReminder(event.chatId, event.reminder, event.every ?? null);
        return;
      }
      case 'chat.loop_request': {
        // spec/02 § Self-wake — a surface arming/stopping a loop reaches the
        // SAME scheduler the agent's patch_loop/patch_cancel_wake tool calls
        // do; `loop: null` cancels (one pending wake per chat, same as the
        // agent path).
        if (event.loop === null) {
          daemon.cancelWake(event.chatId);
        } else {
          daemon.scheduleWake(event.chatId, {
            message: event.loop.message,
            ...(event.loop.every !== undefined ? { every: event.loop.every } : {}),
            ...(event.loop.at !== undefined ? { at: event.loop.at } : {}),
            ...(event.loop.notAfter !== undefined ? { notAfter: event.loop.notAfter } : {}),
          });
        }
        return;
      }
      case 'patch.browser_view.watch': {
        daemon.browserViewWatch(event.chatId, event.tabId, event.watch, {
          ...(event.viewerId !== undefined ? { viewerId: event.viewerId } : {}),
          ...(event.viewport !== undefined ? { viewport: event.viewport } : {}),
        });
        return;
      }
      case 'patch.browser_view.input': {
        // The user's own input: handed straight to the page, never logged.
        void daemon.browserViewInput(event.chatId, event.tabId, event.input);
        return;
      }
      case 'patch.browser_view.drive': {
        daemon.browserViewDrive(event.chatId, event.tabId, event.driver);
        return;
      }
      case 'patch.browser_view.open': {
        void daemon.browserViewOpen(event.chatId, event.url);
        return;
      }
      case 'patch.browser_view.stop': {
        void daemon.browserViewStop(event.chatId);
        return;
      }
      case 'patch.browser_handoff.input': {
        // The user's own keystrokes: handed straight to the page, never logged.
        void daemon.browserHandoffInput(event.chatId, event.handoffId, event.input);
        return;
      }
      case 'patch.browser_handoff.control': {
        daemon.browserHandoffControl(event.chatId, event.action, event.handoffId);
        return;
      }
      case 'chat.permission_response': {
        // Group 20 fix #3: substitute the user's edited content into the
        // SDK tool args (or deny). KNOWN-GAP: SDK runs in
        // bypassPermissions mode, so the original tool call already
        // executed; this emits a paper-trail synthetic tool_call.
        daemon.submitPermissionResponse({
          requestId: event.requestId,
          ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
          decision: event.decision ?? (event.approve ? 'approve' : 'deny'),
          ...(event.editedNewString !== undefined && event.editedNewString !== null
            ? { editedNewString: event.editedNewString }
            : {}),
        });
        return;
      }
      case 'file.write': {
        // Editor save from a surface (diff editor or file browser). Accepted
        // whatever the chat is doing; writeFile rejects with a chat.error only
        // when the path escapes the chat folder, and commits atomically
        // otherwise. See spec/14-design-web.md § Editor.
        daemon.writeFile(event.chatId, event.path, event.content);
        return;
      }
      default:
        // Other events (ack, surface.*) are observability-only for the host
        // today. `chat.focus_change` is intercepted earlier in the onFrame
        // closure (focus-follow routing) and never reaches here.
        logger.debug({ type: event.type }, 'ws-control: ignoring frame type');
    }
  } catch (err) {
    let code: ChatErrorCode;
    if (err instanceof FolderNotFoundError) {
      code = 'folder_not_found';
    } else if (err instanceof NoModelCatalogueError) {
      code = 'no_model_catalogue';
    } else if (err instanceof ChatNotFoundError) {
      code = 'chat_not_found';
    } else if (err instanceof SpeechNotSetUpError) {
      code = 'speech_not_set_up';
    } else {
      code = 'sdk_error';
    }
    const message = err instanceof Error ? err.message : String(err);
    // Spawn-time errors don't have a real chatId on the host yet, but the
    // server pre-allocates one and ships it on `chat.spawn_request.chatId`
    // (group 7). Use that so the server's chat-error waiter can match.
    const chatId = evChatId ?? (event.type === 'chat.spawn_request' ? 'pending-spawn' : undefined);
    logger.warn(
      { op, chatId: chatId ?? 'none', errorCode: code, err: message },
      'ws-control: op rejected',
    );
    // A finished-chats delivery is not about any one chat: its failure goes
    // back as its own result, so the server settles it. A `chat.error` for a
    // made-up chat id is drawn by every surface as a new empty "New chat" row.
    if (event.type === 'manager.finished_run') {
      sender({ type: 'manager.finished_result', runId: event.runId, delivered: 0, error: message });
      return;
    }
    // Any other chat-less op has nothing to attach an error to; logged above.
    if (chatId === undefined) return;
    // F4: allocate the seq through the host's per-chat bumpSeq path when the
    // chat is known, so this error is monotonic + persisted and never collides
    // with a real stream event at seq 0. Unknown chats get OUT_OF_BAND_SEQ
    // (-1) — a marker surfaces won't treat as a replayable stream event.
    const seq = daemon.allocErrorSeq(chatId);
    sender({
      type: 'chat.error',
      chatId,
      error: { code, message },
      seq,
      // A message this host would not take at all: the server stops showing
      // it as held for an offline host (spec/12 § Chat status).
      ...(event.type === 'chat.input' ? { rejectedLocalId: event.localId } : {}),
    });
  }
}

// Only auto-boot when this module is the process's actual entry point (`node
// dist/index.js` / `tsx watch src/index.ts`) — NOT when it's imported as a
// module (e.g. by an in-process integration test importing `main` directly to
// drive it with controlled env + test hooks). `process.argv[1]` is undefined
// in that case (no script arg), so the comparison is simply false and this
// block never runs — `main()` only fires via the explicit call the test
// makes itself.
/* v8 ignore start -- CLI bootstrap glue, structurally identical to
 * src/bin/patch-tools-server.ts's own top-level execution (excluded from
 * coverage in vitest.config.ts for the same reason). This guard is only ever
 * true when `node dist/index.js` (or `tsx watch src/index.ts`) runs THIS file
 * as the OS process's actual entry point — process.argv[1] pointing back at
 * this exact module. Every test in this suite (including this file's own
 * `main()`-driving tests) imports index.ts as a module from inside the
 * vitest worker process, whose argv[1] is vitest's own entry script, so the
 * guard is provably false and the block is unreachable from any in-process
 * test. Exercising it for real would mean spawning a genuine `node` child
 * process to boot a full second host — pure process-bootstrap wiring with
 * nothing left to assert that isn't already covered by calling `main()`
 * directly (which the tests above do extensively, catching every code path
 * inside `main()` itself). */
/**
 * Is this module the script node was asked to run?
 *
 * Realpath on BOTH sides. `process.argv[1]` keeps whatever path the caller
 * typed while `import.meta.url` is already resolved through symlinks, so
 * comparing them directly is silently false whenever anything on the invoked
 * path is a link — the host would simply never call `main()`, with no error.
 * `~/.patch/current` is exactly such a symlink.
 *
 * Duplicated from `scripts/lib/is-main.mjs` rather than imported: `scripts/` is
 * not part of the host's build graph and must not become a runtime dep of the
 * shipped bundle. Keep the two in step.
 */
function isProcessEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isProcessEntrypoint(import.meta.url) && process.argv.includes(WATCHDOG_FLAG)) {
  // The update watchdog: this same build, run as the judge of the update it just started.
  const home = join(process.env['HOME'] ?? homedir(), '.patch');
  runWatchdog({
    home,
    installedVersion: () => currentVersionOf(home, readlinkSync),
    log: (line) => console.log(`[update-watchdog] ${new Date().toISOString()} ${line}`),
  }).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error('[update-watchdog] fatal:', err);
      process.exit(1);
    },
  );
} else if (isProcessEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('[patch-daemon] fatal:', err);
    process.exit(1);
  });
}
/* v8 ignore stop */
