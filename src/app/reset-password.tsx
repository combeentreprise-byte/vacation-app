import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useEffect, useState } from "react";
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
import { supabase } from "@/lib/supabase";

// Supabase's recovery link redirects here with the session tokens attached
// as a URL fragment (`#access_token=...&refresh_token=...&type=recovery`),
// not query params — this client uses the default "implicit" auth flow, and
// detectSessionInUrl is deliberately off (see lib/supabase.ts, needed for
// SSR safety), so nothing parses that fragment automatically. This screen
// has to do it by hand and exchange it for a real session itself.
function extractTokensFromUrl(url: string) {
  const fragment = url.split("#")[1] ?? url.split("?")[1];
  if (!fragment) return null;

  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}

export default function ResetPasswordScreen() {
  const insets = useSafeAreaInsets();
  const { updatePassword } = useAuth();
  const url = Linking.useURL();

  const [status, setStatus] = useState<"pending" | "ready" | "invalid">("pending");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!url) return;
    const currentUrl = url;

    let cancelled = false;

    async function establishSession() {
      const tokens = extractTokensFromUrl(currentUrl);
      if (!tokens) {
        if (!cancelled) setStatus("invalid");
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      if (cancelled) return;
      setStatus(error ? "invalid" : "ready");
    }

    establishSession();

    return () => {
      cancelled = true;
    };
  }, [url]);

  const canSubmit =
    status === "ready" &&
    password.length >= 6 &&
    password === confirmPassword &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    const { error } = await updatePassword(password);
    setIsSubmitting(false);

    if (error) {
      Alert.alert("Couldn't update password", error);
      return;
    }

    Alert.alert("Password updated", "You're all set.");
    router.replace("/");
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
        <Text style={styles.title}>Choose a new password</Text>

        {status === "invalid" ? (
          <Text style={styles.subtitle}>
            This reset link is invalid or has expired. Request a new one from the sign-in screen.
          </Text>
        ) : status === "pending" ? (
          <Text style={styles.subtitle}>Verifying your reset link...</Text>
        ) : (
          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={styles.label}>New password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={Colors.muted}
                secureTextEntry
                style={styles.input}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Confirm new password</Text>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="••••••••"
                placeholderTextColor={Colors.muted}
                secureTextEntry
                style={styles.input}
              />
            </View>

            {password.length > 0 && password.length < 6 ? (
              <Text style={styles.hint}>Password must be at least 6 characters.</Text>
            ) : password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword ? (
              <Text style={styles.hint}>Passwords don&apos;t match.</Text>
            ) : null}

            <Pressable
              style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              <Text style={styles.submitButtonText}>
                {isSubmitting ? "Updating..." : "Update password"}
              </Text>
            </Pressable>
          </View>
        )}
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
    fontSize: 24,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
    color: Colors.muted,
    textAlign: "center",
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
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
  },
  hint: {
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
});
