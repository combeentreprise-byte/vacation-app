import { router } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";
import { useAuth } from "@/hooks/use-auth";

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const { signIn, signUp } = useAuth();

  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The ring around each field is tracked separately from the message: the
  // sign-in "invalid credentials" case rings both fields but only says why
  // once (see errorMessage below), while sign-up's "email already exists"
  // only ever rings the email field.
  const [emailHasError, setEmailHasError] = useState(false);
  const [passwordHasError, setPasswordHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isSubmitting;

  const clearErrors = () => {
    setEmailHasError(false);
    setPasswordHasError(false);
    setErrorMessage(null);
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (errorMessage) clearErrors();
  };

  const handlePasswordChange = (value: string) => {
    setPassword(value);
    if (errorMessage) clearErrors();
  };

  const handleModeToggle = () => {
    setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
    clearErrors();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);

    if (mode === "sign-in") {
      const { error, isInvalidCredentials } = await signIn(email.trim(), password);
      setIsSubmitting(false);

      if (isInvalidCredentials) {
        // Supabase's own error is deliberately generic here (see use-auth.tsx)
        // so this can only mark both fields as suspect, not say which one —
        // that's a genuine can't-know, not a UI shortcut.
        setEmailHasError(true);
        setPasswordHasError(true);
        setErrorMessage("Invalid email or password");
        return;
      }

      if (error) Alert.alert("Couldn't sign in", error);
      return;
    }

    const { error, isEmailTaken } = await signUp(email.trim(), password);
    setIsSubmitting(false);

    if (isEmailTaken) {
      setEmailHasError(true);
      setErrorMessage("Email address already exists");
      return;
    }

    if (error) {
      Alert.alert("Couldn't create account", error);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Vacation App</Text>
        <Text style={styles.subtitle}>
          {mode === "sign-in" ? "Sign in to your account" : "Create an account"}
        </Text>

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <View style={[styles.inputRing, emailHasError && styles.inputRingError]}>
              <TextInput
                value={email}
                onChangeText={handleEmailChange}
                placeholder="you@example.com"
                placeholderTextColor={Colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.input}
              />
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <View style={[styles.inputRing, passwordHasError && styles.inputRingError]}>
              <TextInput
                value={password}
                onChangeText={handlePasswordChange}
                placeholder="••••••••"
                placeholderTextColor={Colors.muted}
                secureTextEntry
                style={styles.input}
              />
            </View>
          </View>

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <Pressable
            style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            <Text style={styles.submitButtonText}>
              {mode === "sign-in" ? "Sign in" : "Create account"}
            </Text>
          </Pressable>

          {mode === "sign-in" ? (
            <Pressable onPress={() => router.push("/forgot-password")} hitSlop={8}>
              <Text style={styles.toggleText}>Forgot password?</Text>
            </Pressable>
          ) : null}

          <Pressable onPress={handleModeToggle} hitSlop={8}>
            <Text style={styles.toggleText}>
              {mode === "sign-in"
                ? "Don't have an account? Sign up"
                : "Already have an account? Sign in"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    color: Colors.muted,
    textAlign: "center",
    marginTop: -12,
  },
  form: {
    gap: 20,
  },
  field: {
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  // A ring drawn around the input rather than a color change on the input's
  // own border, so the input itself always looks the same and the error
  // state reads as "something's wrong here" framing it, not a restyled
  // field. Always at full thickness (just transparent when there's no
  // error) so the ring appearing/disappearing never shifts layout.
  inputRing: {
    borderWidth: 3,
    borderColor: "transparent",
    borderRadius: 14,
    padding: 2,
  },
  inputRingError: {
    borderColor: Colors.danger,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
  },
  errorText: {
    fontSize: 13,
    color: Colors.danger,
    marginTop: -12,
  },
  submitButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
  toggleText: {
    fontSize: 14,
    color: Colors.accent,
    textAlign: "center",
    fontWeight: "500",
  },
});
