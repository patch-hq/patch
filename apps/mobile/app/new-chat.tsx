// New-chat screen (spec/15 § New chat flow) — type-first, the same shape as
// web's new chat (spec/14 § Sidebar §8 / § New-chat setup row). The screen
// reads like the chat it is about to become: a header like a chat's (back,
// "New chat", the project as a pill under it, the call button), an empty
// transcript, and THE chat composer docked at the bottom. Everything a new
// chat decides besides its project — permissions, model, effort, account — is
// that composer's own settings row, exactly as in a chat; this screen only
// holds the picks (`setup`) and hands them to the create call.
//
//   Project — one pill, `<folder> · <machine>`, opening the folder picker sheet
//            (one search box; picking a folder picks its host too).
//
// NOTHING exists server-side until the first send. The composer's send asks
// this screen for its target (`sendTarget`), which creates the chat
// (`POST /api/chats`, the call web makes) and hands back its id; the composer
// then echoes and sends exactly as it would into any chat, and this screen
// navigates into the new chat at once — attachments upload there, in the
// stream, and a failed one stays there as `Not uploaded` with Retry / ×
// (spec/15 § Composer → Attachments; lib/sendQueue.ts). So a created chat is
// always one that was sent into, and backing out before sending leaves no
// chat behind — the draft text and attachments stay under the new-chat draft
// key for next time, as web keeps a new-chat draft.
//
// Untouched, the model and mode ride on nothing: the host resolves its own
// (spec/04 § Spawn) rather than the phone pinning its guess.

import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft, Folder, Phone } from 'lucide-react-native';
import { folderName, type EffortLevel, type PermissionMode } from '@patch/wire';
import { api, ApiError } from '../src/api/rest';
import { getWs } from '../src/api/ws';
import { FolderPickerSheet } from '../src/components/FolderPickerSheet';
import { draftDictationChatId } from '@patch/wire/audio';
import { Composer, type NewChatSetup } from '../src/components/Composer';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { useUiStore } from '../src/stores/uiStore';
import { defaultHostId, hostDefaultModel, usePresenceStore } from '../src/stores/presenceStore';
import { newChatRoute } from '../src/lib/newChat';
import { useNewChatDraftStore } from '../src/stores/newChatDraftStore';
import { buildRecentFolders } from '../src/lib/folderPicker';
import { startVoiceCall } from '../src/lib/voiceCall';
import { loadLastNewChat, saveLastNewChat } from '../src/lib/lastNewChat';
import { modeForModel } from '../src/lib/permissionModes';
import { fonts, radii, space, typography, useTheme } from '../src/lib/theme';
import { useGoBack } from '../src/lib/goBack';

export default function NewChat(): React.ReactElement {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/chats');
  const colors = useTheme();
  // Frozen at open: the recents and model picks below read this snapshot, so a
  // chat changing elsewhere (a job, a hidden thread, a reply landing in an
  // existing chat) never reorders or swaps what the user is looking at.
  const [chats] = React.useState(() => useChatStore.getState().chats);
  const [last] = React.useState(loadLastNewChat);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostIds = React.useMemo(() => Object.keys(hosts), [hosts]);

  // ── Host + folder ─────────────────────────────────────────────────────────
  // Opens on the most recently used (host, folder) pair, else the default host
  // with no folder (spec/14 § Sidebar §8 — "defaults to the most-recently-used
  // (host, folder) pair"). Seeded ONCE, when the roster first has hosts in it
  // (a cold start can open this screen before the greeting lands); after that
  // only the user moves it.
  // A caller that already knows where the chat belongs (chat detail's ⋯ → New
  // chat: "another one here") passes that host + folder, and the screen opens
  // on them instead of the most recent pair — still type-first, nothing is
  // created until the first send.
  const here = useLocalSearchParams<{ hostId?: string; folder?: string; draftId?: string }>();
  const hereHostId = typeof here.hostId === 'string' && here.hostId ? here.hostId : null;
  const hereFolder = typeof here.folder === 'string' && here.folder ? here.folder : null;
  const hereDraftId = typeof here.draftId === 'string' && here.draftId ? here.draftId : null;

  // spec/14 § New chat drafts, spec/15 § New chat flow — the phone gets the
  // full server-synced Drafts list like desktop: this screen always sits on
  // ONE draft (an existing one opened from the Drafts list, or a fresh one),
  // and everything picked here (folder/host/model/text) is that draft's
  // fields. Resolved once, at mount, the same way web resolves `?draft=`.
  const [draftId] = React.useState<string>(() => {
    const st = useNewChatDraftStore.getState();
    if (hereDraftId && st.get(hereDraftId)) return hereDraftId;
    return st.create(hereFolder ?? undefined);
  });
  const failure = useNewChatDraftStore((s) => s.drafts[draftId]?.failure);
  const [sendRequest, setSendRequest] = React.useState(0);
  const [openedDraft] = React.useState(() => useNewChatDraftStore.getState().get(draftId));
  const reopened = hereDraftId !== null && openedDraft !== undefined && openedDraft.text !== '';
  React.useEffect(() => {
    return () => {
      // A blank draft opened and left untouched is not something the user
      // kept (spec/14 § New chat drafts) — collect it on the way out, sparing
      // it if it still has text.
      useNewChatDraftStore.getState().pruneBlank();
    };
  }, []);

  const [hostId, setHostId] = React.useState<string | null>(
    reopened ? (openedDraft?.hostId ?? null) : (hereHostId ?? last?.hostId ?? null),
  );
  const [folder, setFolder] = React.useState<string | null>(
    reopened ? openedDraft?.folder || null : hereHostId ? hereFolder : (last?.folder ?? null),
  );
  const seededRef = React.useRef(
    reopened ? !!openedDraft?.hostId : hereHostId !== null || last !== null,
  );
  React.useEffect(() => {
    if (seededRef.current || hostIds.length === 0) return;
    seededRef.current = true;
    setHostId(defaultHostId(hosts));
  }, [hosts, hostIds]);

  // Every folder the sheet offers, across hosts. The SELECTOR returns the
  // stored map (a stable reference that only changes when a host
  // republishes); the flat list is derived here — a selector that built the
  // array itself would hand React a new reference on every render.
  const hostFolders = useFolderStore((s) => s.byHost);
  const recents = React.useMemo(() => buildRecentFolders(chats, hostFolders), [chats, hostFolders]);
  const [folderSheetOpen, setFolderSheetOpen] = React.useState(false);

  // ── Model ─────────────────────────────────────────────────────────────────
  const hostModel = usePresenceStore((s) => hostDefaultModel(s.hosts, hostId));
  // The explicit choice, or null while there is none — only an explicit
  // choice rides on the spawn, so this is never seeded from `hostModel`.
  const [model, setModel] = React.useState<string | null>(
    reopened ? (openedDraft?.model ?? null) : hereHostId ? null : (last?.model ?? null),
  );
  const effectiveModel = model ?? hostModel;

  // Sync host/folder/model picks into the draft (spec/14 § New chat drafts —
  // every surface's Drafts list shows the same drafts, live). Text itself
  // syncs through the Composer's own draft-store wiring (chatId=draftId).
  React.useEffect(() => {
    useNewChatDraftStore.getState().update(draftId, {
      folder: folder ?? '',
      ...(hostId !== null ? { hostId } : {}),
      ...(model !== null ? { model } : {}),
    });
  }, [draftId, folder, hostId, model]);
  // The shared accounts a chat on this model could start on (spec/10 —
  // preferred account); null leaves it to the strategy.
  const [preferredAccountId, setPreferredAccountId] = React.useState<string | null>(null);
  const sharedSecrets = useSettingsStore((st) => st.data?.shared?.secrets);
  const preferable = React.useMemo(
    () =>
      (
        (effectiveModel?.startsWith('openai/') ? sharedSecrets?.codex : sharedSecrets?.claude) ?? []
      ).filter((a) => a.connected),
    [sharedSecrets, effectiveModel],
  );
  React.useEffect(() => {
    if (preferredAccountId !== null && !preferable.some((a) => a.id === preferredAccountId)) {
      setPreferredAccountId(null);
    }
  }, [preferable, preferredAccountId]);
  // Thinking effort: only a pick rides to the new chat (sent as the chat's
  // effort once it exists); untouched, the model decides.
  const [effort, setEffort] = React.useState<EffortLevel | null>(null);

  // ── Permission mode ───────────────────────────────────────────────────────
  const hostModeDefault = usePresenceStore((s) =>
    hostId ? (s.hosts[hostId]?.host?.permissionModeDefault ?? null) : null,
  );
  const [pickedMode, setMode] = React.useState<PermissionMode | null>(
    hereHostId ? null : (last?.permissionMode ?? null),
  );
  // The mode stands only while the model can run it: pick Auto, then a model
  // without it, and Claude Code would quietly run `default` under an "Auto" label.
  const mode = modeForModel(pickedMode, effectiveModel);
  const effectiveMode = mode ?? modeForModel(hostModeDefault, effectiveModel);

  const chooseFolder = (id: string, picked: string): void => {
    const h = hosts[id];
    if (h && !h.online) {
      useUiStore
        .getState()
        .pushError(`${h.host?.hostName ?? id} is offline — start the chat on another host`);
      return;
    }
    if (id !== hostId) {
      // A model and a mode belong to the machine they were picked on; neither
      // carries over to another.
      setModel(null);
      setMode(null);
      setPreferredAccountId(null);
    }
    setHostId(id);
    setFolder(picked);
    setFolderSheetOpen(false);
  };

  // ── Create on first send ──────────────────────────────────────────────────
  // Once created, the send goes into the chat at once (its uploads follow it
  // there), so there is never a created chat left to retry into or discard.
  const sendTarget = async (): Promise<string | null> => {
    const pushError = useUiStore.getState().pushError;
    if (hostId === null) {
      pushError('Choose which machine to start the chat on.');
      return null;
    }
    if (folder === null) {
      pushError('Choose a folder before sending.');
      return null;
    }
    try {
      const res = await api.createChat({
        hostId,
        folder,
        ...(model === null ? {} : { model }),
        ...(mode === null ? {} : { permissionMode: mode }),
        ...(preferredAccountId === null ? {} : { preferredAccountId }),
      });
      // Seed the row BEFORE the composer echoes into it and before navigating
      // (spec/15 § New chat flow): a chat with no store row is invisible to
      // the WS replay loop, so it would never receive a reply. The server's
      // echoed folder is the canonical path `chat.spawned` will carry.
      useChatStore.getState().ensureChat(res.chatId, res.folder);
      saveLastNewChat({ hostId, folder, model, permissionMode: mode });
      if (effort !== null) {
        getWs().send({ type: 'chat.effort_request', chatId: res.chatId, effort });
      }
      return res.chatId;
    } catch (e) {
      // The host's `chat.error` for a refused spawn may already have seeded
      // a row for a chat that does not exist — retract it (web does the same).
      const body = e instanceof ApiError ? (e.body as { retractChatId?: string } | null) : null;
      if (body?.retractChatId) useChatStore.getState().removeChat(body.retractChatId);
      pushError(`Failed to create chat: ${(e as Error).message}`);
      // The message stays as a failed chat (spec/04 § Spawn), with a resend.
      const drafts = useNewChatDraftStore.getState();
      drafts.markFailed(
        draftId,
        drafts.get(draftId)?.text ?? '',
        `Failed to create chat: ${(e as Error).message}`,
      );
      return null;
    }
  };

  const onSent = (chatId: string): void => {
    // The draft is now a real chat — consume it everywhere (spec/14 § New
    // chat drafts — "consumed the moment its first message is sent").
    useNewChatDraftStore.getState().remove(draftId);
    // Always the brand-new chat — never Manager (spec/15 item 16).
    router.replace(newChatRoute(chatId) as `/chats/${string}`);
  };

  const hostLabel = (id: string): string => hosts[id]?.host?.hostName ?? id;
  const pickerHosts = Object.values(hosts)
    .map((h) => ({ hostId: h.hostId, name: hostLabel(h.hostId), online: h.online }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const setup: NewChatSetup = {
    hostId,
    model: effectiveModel,
    onModel: setModel,
    mode: effectiveMode,
    onMode: setMode,
    effort,
    onEffort: setEffort,
    accountId: preferredAccountId,
    onAccount: setPreferredAccountId,
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, paddingTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md }}>
        <Pressable onPress={goBack} style={{ padding: space.sm }} accessibilityLabel="Cancel">
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
          <Text
            testID="new-chat-title"
            numberOfLines={1}
            style={{ ...typography.title, color: colors.ink }}
          >
            New chat
          </Text>
          <Pressable
            testID="new-chat-folder-pill"
            onPress={() => setFolderSheetOpen(true)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              maxWidth: '100%',
              paddingHorizontal: space.sm,
              paddingVertical: 2,
              borderRadius: radii.pill,
              backgroundColor: pressed ? colors.divider : colors.lineSoft,
            })}
          >
            <Folder size={14} color={colors.ink3} />
            <Text
              numberOfLines={1}
              style={{ ...typography.meta, color: colors.ink2, flexShrink: 1 }}
            >
              {folder === null
                ? 'Choose a folder…'
                : `${folderName(folder)}${hostId ? ` · ${hostLabel(hostId)}` : ''}`}
            </Text>
            <ChevronDown size={14} color={colors.ink3} />
          </Pressable>
        </View>
        <Pressable
          testID="new-chat-call"
          onPress={() => {
            if (hostId === null) {
              useUiStore.getState().pushError('Choose which machine to call.');
              return;
            }
            startVoiceCall(draftDictationChatId(hostId));
          }}
          style={{ padding: space.sm }}
          accessibilityRole="button"
          accessibilityLabel="Start voice call"
        >
          <Phone size={20} color={colors.ink} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* The empty transcript: nothing to show until the first send, other
            than a failed start with its reason. */}
        <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: space.sm }}>
          {failure ? (
            <View
              testID="new-chat-failed"
              style={{ alignItems: 'center', paddingBottom: space.sm }}
            >
              <Text style={{ color: colors.red, ...typography.meta }}>Chat didn’t start</Text>
              <Text
                testID="new-chat-failed-error"
                style={{ color: colors.ink2, ...typography.meta }}
              >
                {failure.sentence}
              </Text>
              <Pressable
                testID="new-chat-resend"
                accessibilityRole="button"
                onPress={() => {
                  useNewChatDraftStore.getState().clearFailure(draftId);
                  setSendRequest((n) => n + 1);
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderRadius: radii.lg,
                  borderWidth: 1,
                  borderColor: colors.divider,
                  backgroundColor: pressed ? colors.divider : colors.paper,
                })}
              >
                <Text style={{ color: colors.ink2, fontFamily: fonts.body, fontSize: 14 }}>
                  Resend
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <Composer
          chatId={draftId}
          dictationChatId={hostId ? draftDictationChatId(hostId) : undefined}
          folder={folder ?? undefined}
          sendTarget={sendTarget}
          setup={setup}
          sendRequest={sendRequest}
          onSent={onSent}
        />
      </KeyboardAvoidingView>

      <FolderPickerSheet
        visible={folderSheetOpen}
        recents={recents}
        hosts={pickerHosts}
        currentHostId={hostId}
        onPick={chooseFolder}
        onDismiss={() => setFolderSheetOpen(false)}
      />
    </View>
  );
}
