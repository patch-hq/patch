// GoalBar — the chat's goal (`/goal`) above the transcript. Mobile port of web's
// GoalBanner (packages/web/src/components/GoalBanner.tsx), same data and route.
// At rest it is one truncated line; tapping it opens the full goal, whose text
// is then tap-to-edit (InlineEditText). × clears it. Optimistic, reverting with
// a toast on failure (lib/chatMeta). No bar when the chat has no goal.

import React, { useState, type ReactElement } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ReminderEvery } from '@patch/wire';
import { ChevronDown, ChevronUp, Target, X } from 'lucide-react-native';
import type { ChatRow } from '../../stores/types';
import { planOf, writeGoal } from '../../lib/chatMeta';
import { space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';
import { InlineEditText } from './InlineEditText';

const PRESETS: Array<ReminderEvery | null> = [
  null,
  { unit: 'turns', n: 3 },
  { unit: 'turns', n: 10 },
  { unit: 'minutes', n: 15 },
  { unit: 'minutes', n: 60 },
];

function everyLabel(e: ReminderEvery | null): string {
  if (e === null) return 'Off';
  return e.unit === 'turns' ? `${e.n} turns` : `${e.n} min`;
}

function same(a: ReminderEvery | null, b: ReminderEvery | null): boolean {
  return a === b || (a !== null && b !== null && a.unit === b.unit && a.n === b.n);
}

/** One cadence as a row of chips: Off and a few presets, plus whatever else is set. */
function CadenceRow({
  label,
  testID,
  value,
  onChange,
}: {
  label: string;
  testID: string;
  value: ReminderEvery | null;
  onChange: (next: ReminderEvery | null) => void;
}): ReactElement {
  const colors = useTheme();
  const options = PRESETS.some((p) => same(p, value)) ? PRESETS : [...PRESETS, value];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm }}>
      <Text style={{ color: colors.ink2, fontSize: textMin }}>{label}</Text>
      {options.map((o) => {
        const selected = same(o, value);
        return (
          <Pressable
            key={everyLabel(o)}
            testID={`${testID}-${o === null ? 'off' : `${o.unit}-${o.n}`}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${label}: ${everyLabel(o)}`}
            onPress={() => onChange(o)}
            hitSlop={6}
          >
            <Text style={{ color: selected ? colors.ink : colors.ink3, fontSize: textMin }}>
              {selected ? `[${everyLabel(o)}]` : everyLabel(o)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function GoalBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState('');
  const goal = row.goal;
  if (goal === null || goal.trim() === '') return null;
  const textStyle = { color: colors.ink2, fontSize: textMin };
  const plan = planOf(row);
  // Every edit sends the whole plan with the goal, like web's editor.
  const write = (next: string, changes: Partial<typeof plan>): void => {
    const merged = { ...plan, ...changes };
    const empty =
      merged.then.length === 0 && merged.remindEvery === null && merged.checkInEvery === null;
    void writeGoal(row.chatId, next, empty ? {} : merged);
  };

  return (
    <BarShell testID="goal-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Target size={14} color={colors.ink2} />
        {open ? (
          <InlineEditText
            testID="goal-bar-text"
            editLabel="Edit goal"
            value={goal}
            onCommit={(next) => write(next, {})}
            textStyle={textStyle}
          />
        ) : (
          <Pressable
            testID="goal-bar-summary"
            accessibilityRole="button"
            accessibilityLabel="Show goal"
            onPress={() => setOpen(true)}
            style={{ flex: 1 }}
          >
            <Text numberOfLines={1} style={textStyle}>
              {goal}
              {plan.then.length > 0 ? ` · ${plan.then.length} to follow` : ''}
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="goal-bar-toggle"
          accessibilityRole="button"
          accessibilityLabel={open ? 'Collapse goal' : 'Expand goal'}
          onPress={() => setOpen(!open)}
          hitSlop={8}
        >
          {open ? (
            <ChevronUp size={14} color={colors.ink3} />
          ) : (
            <ChevronDown size={14} color={colors.ink3} />
          )}
        </Pressable>
        <Pressable
          testID="goal-clear-btn"
          accessibilityRole="button"
          accessibilityLabel="Clear goal"
          onPress={() => void writeGoal(row.chatId, null)}
          hitSlop={8}
        >
          <X size={14} color={colors.ink3} />
        </Pressable>
      </View>
      {open ? (
        <View style={{ gap: space.sm, paddingTop: space.sm }}>
          {plan.then.map((g, i) => (
            <View
              key={`${i}-${g}`}
              testID={`goal-then-${i}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
            >
              <Text style={{ ...textStyle, flex: 1 }}>{`Then ${i + 1}: ${g}`}</Text>
              <Pressable
                testID={`goal-then-remove-${i}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove then goal ${i + 1}`}
                onPress={() => write(goal, { then: plan.then.filter((_, j) => j !== i) })}
                hitSlop={8}
              >
                <X size={14} color={colors.ink3} />
              </Pressable>
            </View>
          ))}
          <TextInput
            testID="goal-then-input"
            accessibilityLabel="Add a goal to follow"
            placeholder="Then…"
            placeholderTextColor={colors.ink3}
            value={adding}
            onChangeText={setAdding}
            onSubmitEditing={() => {
              const next = adding.trim();
              if (next === '') return;
              setAdding('');
              write(goal, { then: [...plan.then, next] });
            }}
            returnKeyType="done"
            style={textStyle}
          />
          <CadenceRow
            label="Remind"
            testID="goal-remind"
            value={plan.remindEvery}
            onChange={(remindEvery) => write(goal, { remindEvery })}
          />
          <CadenceRow
            label="Check in"
            testID="goal-checkin"
            value={plan.checkInEvery}
            onChange={(checkInEvery) => write(goal, { checkInEvery })}
          />
        </View>
      ) : null}
    </BarShell>
  );
}
