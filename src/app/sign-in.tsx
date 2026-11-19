import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { Button, colors, ErrorNotice, Field } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';

export default function SignIn() {
  const { signIn, signUp } = useSession();
  const { analytics } = useServices();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'sign-in') await signIn(email.trim(), password);
      else await signUp(email.trim(), password, name.trim());
      analytics.track({ name: 'signed_in' });
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <View style={styles.form}>
        <Text accessibilityRole="header" style={styles.heading}>
          Care Log
        </Text>
        <Text style={styles.subheading}>Sign in with the email your care provider invited.</Text>
        {mode === 'sign-up' ? <Field label="Full name" onChangeText={setName} value={name} /> : null}
        <Field inputMode="email" label="Email" onChangeText={setEmail} testID="email" value={email} />
        <Field label="Password" onChangeText={setPassword} secure testID="password" value={password} />
        {error ? <ErrorNotice error={error} /> : null}
        <Button label={mode === 'sign-in' ? 'Sign in' : 'Create account'} loading={busy} onPress={submit} testID="submit" />
        <Button
          label={mode === 'sign-in' ? 'Got an invitation? Create your account' : 'Have an account? Sign in'}
          onPress={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
          variant="secondary"
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1, justifyContent: 'center' },
  form: { gap: 12, padding: 24 },
  heading: { color: colors.text, fontSize: 28, fontWeight: '700' },
  subheading: { color: colors.muted, fontSize: 15, marginBottom: 8 },
});
