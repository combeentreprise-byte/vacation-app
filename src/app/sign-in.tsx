import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AuthForm } from "@/components/auth-form";
import { Colors } from "@/constants/colors";
import { useOnboarding } from "@/hooks/use-onboarding";

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const { cancelSignUp } = useOnboarding();

  // Whoever signs in from here has an existing account, which shouldn't get
  // an unfinished onboarding (say, a Google sign-up backed out of on its last
  // step) saved over it — see OnboardingDraft.isSigningUp.
  useFocusEffect(
    useCallback(() => {
      cancelSignUp();
    }, [cancelSignUp])
  );

  // New accounts are only made at the end of onboarding, so everyone picks a
  // name first. Back to it if that's where this came from, rather than
  // stacking another one on top.
  const handleSignUp = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.push("/onboarding");
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
        <Text style={styles.subtitle}>Sign in to your account</Text>

        <AuthForm
          mode="sign-in"
          footer={
            <>
              <Pressable onPress={() => router.push("/forgot-password")} hitSlop={8}>
                <Text style={styles.linkText}>Forgot password?</Text>
              </Pressable>
              <Pressable onPress={handleSignUp} hitSlop={8}>
                <Text style={styles.linkText}>Don&apos;t have an account? Sign up</Text>
              </Pressable>
            </>
          }
        />
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
  linkText: {
    fontSize: 14,
    color: Colors.accent,
    textAlign: "center",
    fontWeight: "500",
  },
});
