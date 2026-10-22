// BrowserLiveCard — the agent's browser, live above the composer (spec/15 §
// Browser): a small picture of the tab with its site, how long, who has it and
// Take over / Hand back / Done. Tapping the picture opens the browser over the
// whole screen (BrowserOpenView). When the agent hands over a page with a
// sign-in form, the card is that form instead, as this phone's own fields, so
// nobody types a password into a small picture of a page.

import React, { useState, type ReactElement } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
import { Lock, X } from 'lucide-react-native';
import { useBrowserHandoffStore, type BrowserForm } from '../../stores/browserHandoffStore';
import { driveState, formatElapsed, siteOf, viewedTab } from '../../lib/browserHandoff';
import { sendDone, sendInput, useBrowserWatch, useNow } from '../../lib/browserView';
import { radii, space, textMin, useTheme } from '../../lib/theme';
import { DriveAction, DriveChip, SiteTile, TOUCH_TARGET } from './parts';
import { BrowserOpenView } from './BrowserOpenView';

export function BrowserLiveCard({ chatId }: { chatId: string }): ReactElement | null {
  const view = useBrowserHandoffStore((s) => s.views[chatId]);
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const form = useBrowserHandoffStore((s) => s.forms[chatId]);
  const [usePage, setUsePage] = useState<string | null>(null);
  if (!status && !handoff) return null;
  if (view === 'open') return <BrowserOpenView chatId={chatId} />;
  if (view !== 'card') return null;
  if (handoff && form && usePage !== form.formId) {
    return (
      <SignInCard
        chatId={chatId}
        form={form}
        handoffId={handoff.handoffId}
        onUsePage={() => setUsePage(form.formId)}
      />
    );
  }
  return <LivePicture chatId={chatId} />;
}

function LivePicture({ chatId }: { chatId: string }): ReactElement {
  const colors = useTheme();
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const setView = useBrowserHandoffStore((s) => s.setView);
  const tabId = viewedTab(handoff, frame, status);
  const state = driveState(handoff, status, tabId);
  const shown = frame && frame.tabId === tabId ? frame : undefined;
  const site = siteOf(status?.tabs.find((t) => t.tabId === tabId)?.url ?? frame?.url ?? '');
  const now = useNow(status?.since !== undefined);
  useBrowserWatch(chatId, true, tabId, null);
  return (
    <View
      testID="browser-handoff"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        marginHorizontal: space.md,
        marginBottom: space.sm,
        padding: space.sm,
        backgroundColor: colors.paperRaised,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        borderRadius: radii.lg,
      }}
    >
      <Pressable
        testID="browser-handoff-expand"
        accessibilityRole="button"
        accessibilityLabel="Open the browser"
        onPress={() => setView(chatId, 'open')}
        style={{
          width: 96,
          height: 64,
          borderRadius: radii.md,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.lineSoft,
          backgroundColor: colors.bgSoft,
        }}
      >
        {shown ? (
          <Image
            testID="browser-handoff-preview"
            source={{ uri: `data:image/jpeg;base64,${shown.data}` }}
            resizeMode="cover"
            style={{ width: '100%', height: '100%' }}
          />
        ) : null}
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <DriveChip state={state} />
          {status?.since !== undefined ? (
            <Text
              style={{ color: colors.inkFaint, fontSize: textMin, fontVariant: ['tabular-nums'] }}
            >
              {formatElapsed(now - status.since)}
            </Text>
          ) : null}
        </View>
        <Text
          testID="browser-handoff-title"
          numberOfLines={1}
          style={{ color: colors.ink2, fontSize: textMin }}
        >
          {state === 'needs' && handoff ? handoff.reason : site || 'Connecting'}
        </Text>
      </View>
      <DriveAction
        chatId={chatId}
        tabId={tabId}
        state={state}
        handoffId={handoff?.handoffId}
        canDrive={(frame?.inputVersion ?? 0) >= 2}
        onTakeOver={() => setView(chatId, 'open')}
      />
      <Pressable
        testID="browser-watch-close"
        accessibilityRole="button"
        accessibilityLabel="Hide the browser"
        onPress={() => setView(chatId, undefined)}
        style={{
          minWidth: TOUCH_TARGET,
          minHeight: TOUCH_TARGET,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={18} color={colors.ink3} />
      </Pressable>
    </View>
  );
}

/**
 * The page's sign-in form as this phone's own fields. The values go straight
 * into the page's fields; the agent never sees them.
 */
export function SignInCard({
  chatId,
  form,
  handoffId,
  onUsePage,
}: {
  chatId: string;
  form: BrowserForm;
  handoffId: string;
  onUsePage: () => void;
}): ReactElement {
  const colors = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const submit = (): void => {
    const filled = form.fields
      .map((f) => ({ field: f.field, value: values[f.field] ?? '' }))
      .filter((v) => v.value !== '');
    if (filled.length === 0) return;
    sendInput(chatId, form.tabId, true, handoffId, {
      kind: 'fill',
      formId: form.formId,
      values: filled,
      submit: true,
    });
    setValues({});
  };
  const link = { color: colors.ink3, fontSize: textMin };
  return (
    <View
      testID="browser-signin"
      style={{
        marginHorizontal: space.md,
        marginBottom: space.sm,
        padding: space.lg,
        gap: space.md,
        backgroundColor: colors.paperRaised,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        borderRadius: radii.lg,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <SiteTile site={form.site} size={30} />
        <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '600' }}>
          Sign in to {form.site}
        </Text>
      </View>
      {form.fields.map((f, i) => (
        <TextInput
          key={f.field}
          testID={`browser-signin-${f.kind}`}
          accessibilityLabel={f.label}
          placeholder={f.label}
          placeholderTextColor={colors.inkFaint}
          secureTextEntry={f.kind === 'password'}
          keyboardType={
            f.kind === 'email' ? 'email-address' : f.kind === 'code' ? 'number-pad' : 'default'
          }
          autoComplete={
            f.kind === 'password'
              ? 'current-password'
              : f.kind === 'code'
                ? 'one-time-code'
                : 'username'
          }
          textContentType={
            f.kind === 'password' ? 'password' : f.kind === 'code' ? 'oneTimeCode' : 'username'
          }
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={i === 0}
          value={values[f.field] ?? ''}
          onChangeText={(t: string) => setValues((v) => ({ ...v, [f.field]: t }))}
          onSubmitEditing={i === form.fields.length - 1 ? submit : undefined}
          style={{
            minHeight: TOUCH_TARGET,
            paddingHorizontal: space.md,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: radii.md,
            backgroundColor: colors.paper,
            color: colors.ink,
            fontSize: 16,
          }}
        />
      ))}
      <Pressable
        testID="browser-signin-submit"
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={submit}
        style={{
          minHeight: TOUCH_TARGET,
          borderRadius: radii.pill,
          backgroundColor: colors.ink,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.paperRaised, fontSize: textMin, fontWeight: '600' }}>
          Sign in
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Pressable
          testID="browser-signin-page"
          accessibilityRole="button"
          onPress={onUsePage}
          style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
        >
          <Text style={link}>Use the page instead</Text>
        </Pressable>
        <Pressable
          testID="browser-signin-skip"
          accessibilityRole="button"
          onPress={() => sendDone(chatId, handoffId, 'cancel')}
          style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
        >
          <Text style={link}>Skip</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Lock size={13} color={colors.inkFaint} />
        <Text style={{ color: colors.inkFaint, fontSize: textMin }}>
          The agent can’t see what you type
        </Text>
      </View>
    </View>
  );
}
