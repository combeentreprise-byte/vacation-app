import { Ionicons } from "@expo/vector-icons";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Colors } from "@/constants/colors";
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from "@/constants/limits";
import { useAuth } from "@/hooks/use-auth";
import { showComingSoon } from "@/utils/coming-soon";
import type { OAuthProvider } from "@/utils/oauth";
import { meetsPasswordRequirements, PASSWORD_REQUIREMENTS } from "@/utils/password";

type AuthFormProps = {
  mode: "sign-in" | "sign-up";
  // Awaited right before any attempt starts (email or OAuth) — onboarding
  // uses it to mark its draft for the account about to be created, which has
  // to be saved before web's Google sign-in navigates away from the app.
  onBeforeAuth?: () => Promise<void>;
  // Extra links under the submit button, spaced like the rest of the form.
  footer?: ReactNode;
};

// The Apple/Google buttons plus email + password form, shared by the sign-in
// screen (mode "sign-in") and the last step of onboarding (mode "sign-up").
// Signing in or up successfully needs no navigation here: the new session
// flips the Stack.Protected guards in app/_layout.tsx, which swaps the
// screens itself.
export function AuthForm({ mode, onBeforeAuth, footer }: AuthFormProps) {
  const { signIn, signUp, signInWithOAuth } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthPending, setOauthPending] = useState<OAuthProvider | null>(null);
  // The ring around each field is tracked separately from the message: the
  // sign-in "invalid credentials" case rings both fields but only says why
  // once (see errorMessage below), while sign-up's "email already exists"
  // only ever rings the email field and "weak password" only the password.
  const [emailHasError, setEmailHasError] = useState(false);
  const [passwordHasError, setPasswordHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === "sign-in" || meetsPasswordRequirements(password)) &&
    !isSubmitting;

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

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    await onBeforeAuth?.();

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

    const { error, isEmailTaken, isWeakPassword } = await signUp(email.trim(), password);
    setIsSubmitting(false);

    if (isEmailTaken) {
      setEmailHasError(true);
      setErrorMessage("Email address already exists");
      return;
    }

    if (isWeakPassword && error) {
      // Supabase's message already spells out the unmet requirement
      // (e.g. minimum length), so show it as-is under the ringed field.
      setPasswordHasError(true);
      setErrorMessage(error);
      return;
    }

    if (error) {
      Alert.alert("Couldn't create account", error);
    }
  };

  const handleOAuthPress = async (provider: OAuthProvider) => {
    if (oauthPending) return;

    // Apple sign-in isn't wired up on the Supabase side yet (see use-auth.tsx
    // signInWithOAuth) — route it through the same "not built yet" pattern
    // every other unfinished feature uses instead of hitting the API and
    // showing a raw Supabase validation error.
    if (provider === "apple") {
      showComingSoon("Sign in with Apple");
      return;
    }

    setOauthPending(provider);
    await onBeforeAuth?.();
    const { error } = await signInWithOAuth(provider);
    setOauthPending(null);

    if (error) {
      Alert.alert("Couldn't sign in with Google", error);
    }
  };

  return (
    <>
      <View style={styles.oauthGroup}>
        <Pressable
          style={[styles.oauthButton, styles.appleButton]}
          onPress={() => handleOAuthPress("apple")}
          disabled={oauthPending !== null}
        >
          {oauthPending === "apple" ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="logo-apple" size={20} color="#FFFFFF" />
              <Text style={styles.appleButtonText}>Continue with Apple</Text>
            </>
          )}
        </Pressable>

        <Pressable
          style={[styles.oauthButton, styles.googleButton]}
          onPress={() => handleOAuthPress("google")}
          disabled={oauthPending !== null}
        >
          {oauthPending === "google" ? (
            <ActivityIndicator color={Colors.text} />
          ) : (
            <>
              <Ionicons name="logo-google" size={20} color={Colors.text} />
              <Text style={styles.googleButtonText}>Continue with Google</Text>
            </>
          )}
        </Pressable>
      </View>

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

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
              maxLength={EMAIL_MAX_LENGTH}
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
              secureTextEntry={!isPasswordVisible}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, styles.passwordInput]}
              maxLength={PASSWORD_MAX_LENGTH}
            />
            <Pressable
              style={styles.visibilityToggle}
              onPress={() => setIsPasswordVisible((current) => !current)}
              accessibilityRole="button"
              accessibilityLabel={isPasswordVisible ? "Hide password" : "Show password"}
              hitSlop={8}
            >
              <Ionicons
                name={isPasswordVisible ? "eye-off-outline" : "eye-outline"}
                size={20}
                color={Colors.muted}
              />
            </Pressable>
          </View>
          {mode === "sign-up" ? (
            <View style={styles.requirements}>
              {PASSWORD_REQUIREMENTS.map((requirement) => {
                const isMet = requirement.isMet(password);
                return (
                  <View key={requirement.label} style={styles.requirementRow}>
                    <Ionicons
                      name={isMet ? "checkmark-circle" : "ellipse-outline"}
                      size={16}
                      color={isMet ? Colors.success : Colors.muted}
                    />
                    <Text style={[styles.requirementText, isMet && styles.requirementTextMet]}>
                      {requirement.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
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

        {footer}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  oauthGroup: {
    gap: 12,
  },
  oauthButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 10,
    paddingVertical: 14,
    borderWidth: 1,
  },
  appleButton: {
    backgroundColor: "#000000",
    borderColor: "#000000",
  },
  appleButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  googleButton: {
    backgroundColor: Colors.background,
    borderColor: Colors.border,
  },
  googleButtonText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.border,
  },
  dividerText: {
    fontSize: 13,
    color: Colors.muted,
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
  passwordInput: {
    paddingRight: 48,
  },
  // Absolute positioning is relative to inputRing's padding box, so the
  // 2px insets line the toggle up with the input's own edges.
  visibilityToggle: {
    position: "absolute",
    top: 2,
    bottom: 2,
    right: 2,
    width: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  requirements: {
    gap: 4,
  },
  requirementRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  requirementText: {
    fontSize: 13,
    color: Colors.muted,
  },
  requirementTextMet: {
    color: Colors.success,
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
});
