import { router } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AuthForm } from "@/components/auth-form";
import { OnboardingHeader } from "@/components/onboarding-header";
import { Colors } from "@/constants/colors";
import { useOnboarding } from "@/hooks/use-onboarding";

// The last onboarding step. Nothing here saves the draft itself: signing up
// flips app/_layout.tsx's guards into the signed-in app, and
// OnboardingProvider saves everything to the new account from there.
export default function OnboardingSignUpScreen() {
  const { draft, beginSignUp } = useOnboarding();

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <OnboardingHeader step={3} onBack={() => router.back()} />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.intro}>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>
            {draft.group
              ? `Last step: sign up to save “${draft.group.name}” and invite your friends.`
              : "Last step: sign up to start splitting costs with your friends."}
          </Text>
        </View>

        <AuthForm
          mode="sign-up"
          onBeforeAuth={beginSignUp}
          footer={
            // Signing in to an existing account instead leaves this draft
            // behind (see OnboardingDraft.isSigningUp).
            <Pressable onPress={() => router.push("/sign-in")} hitSlop={8}>
              <Text style={styles.signInText}>Already have an account? Sign in</Text>
            </Pressable>
          }
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 20,
    gap: 24,
  },
  intro: {
    gap: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: Colors.text,
  },
  subtitle: {
    fontSize: 15,
    color: Colors.muted,
  },
  signInText: {
    fontSize: 14,
    color: Colors.accent,
    textAlign: "center",
    fontWeight: "500",
  },
});
