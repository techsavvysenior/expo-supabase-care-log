import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { AppError } from '@/core/errors';

export const colors = {
  background: '#F6F7F9',
  surface: '#FFFFFF',
  border: '#E3E6EB',
  text: '#14171F',
  muted: '#5B6472',
  primary: '#0B6E6E',
  onPrimary: '#FFFFFF',
  danger: '#B3261E',
  dangerSurface: '#FCEEEE',
  success: '#17713F',
};

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  testID,
  style,
}: ButtonProps) {
  const inactive = disabled || loading;
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        (inactive || pressed) && styles.dimmed,
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={primary ? colors.onPrimary : colors.primary} />
      ) : (
        <Text style={[styles.buttonLabel, !primary && styles.buttonLabelSecondary]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function ErrorNotice({ error, onRetry }: { error: AppError; onRetry?: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.noticeText}>{error.userMessage}</Text>
      {onRetry && error.retryable ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onRetry}>
          <Text style={styles.noticeAction}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function Loading() {
  return (
    <Centered>
      <ActivityIndicator accessibilityLabel="Loading" color={colors.primary} size="large" />
    </Centered>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Centered>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </Centered>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  buttonLabel: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  buttonLabelSecondary: { color: colors.primary },
  dimmed: { opacity: 0.6 },
  notice: {
    alignItems: 'center',
    backgroundColor: colors.dangerSurface,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  noticeText: { color: colors.danger, flex: 1, fontSize: 15 },
  noticeAction: { color: colors.danger, fontSize: 15, fontWeight: '700' },
  centered: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 24 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  emptyBody: { color: colors.muted, fontSize: 15, textAlign: 'center' },
});

export function Screen({ children }: { children: ReactNode }) {
  return <View style={screenStyles.screen}>{children}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[screenStyles.card, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={screenStyles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={screenStyles.muted}>{children}</Text>;
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'danger' }) {
  return (
    <View style={[screenStyles.badge, tone === 'success' && screenStyles.badgeSuccess, tone === 'danger' && screenStyles.badgeDanger]}>
      <Text style={screenStyles.badgeText}>{label}</Text>
    </View>
  );
}

const screenStyles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1, gap: 12, padding: 16 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 14 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  badgeSuccess: { backgroundColor: '#DDF2E5' },
  badgeDanger: { backgroundColor: colors.dangerSurface },
  badgeText: { color: colors.text, fontSize: 12, fontWeight: '600' },
});

export function Field(props: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
  secure?: boolean;
  inputMode?: 'email' | 'text' | 'tel';
  testID?: string;
}) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        autoCapitalize={props.inputMode === 'email' ? 'none' : 'sentences'}
        inputMode={props.inputMode}
        multiline={props.multiline}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        secureTextEntry={props.secure}
        style={[fieldStyles.input, props.multiline && fieldStyles.multiline]}
        testID={props.testID}
        value={props.value}
      />
    </View>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={fieldStyles.chips}>
      {options.map((option) => (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ selected: option === value }}
          key={option}
          onPress={() => onChange(option)}
          style={[fieldStyles.chip, option === value && fieldStyles.chipOn]}>
          <Text style={[fieldStyles.chipText, option === value && fieldStyles.chipTextOn]}>{option}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  wrap: { gap: 4 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  multiline: { minHeight: 110, paddingTop: 10, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderColor: colors.border, borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 14 },
  chipTextOn: { color: colors.onPrimary, fontWeight: '600' },
});
