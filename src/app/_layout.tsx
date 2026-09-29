import { Stack } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { Colors } from "@/constants/colors";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { GroupsProvider } from "@/hooks/use-groups";
import { LogsProvider } from "@/hooks/use-logs";
import { OnboardingProvider, useOnboarding } from "@/hooks/use-onboarding";
import { ProfileProvider } from "@/hooks/use-profile";

function RootNavigator() {
  const { session, isLoading } = useAuth();
  const { isLoaded: isOnboardingLoaded, hasSignedInOnDevice, isFinishing } = useOnboarding();

  if (isLoading || !isOnboardingLoaded) {
    return <View style={{ flex: 1 }} />;
  }

  const signInScreen = <Stack.Screen name="sign-in" />;

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!session}>
          {/* A signed-out user lands on whichever of these comes first:
              onboarding on a device nobody has signed in on yet, the
              sign-in screen once someone has (e.g. after signing out). Each
              links to the other. */}
          {hasSignedInOnDevice ? signInScreen : null}
          <Stack.Screen name="onboarding" />
          {hasSignedInOnDevice ? null : signInScreen}
          <Stack.Screen name="forgot-password" />
        </Stack.Protected>

        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="new-group"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="add-entry"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="scan-receipt"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="scan-pick-group"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen name="join/[id]" />
        </Stack.Protected>

        {/* Ungated: reached via a Supabase recovery email link or an OAuth
            redirect, both of which can land before this client has a session
            of its own yet, so neither can be gated on session state. */}
        <Stack.Screen name="reset-password" />
        <Stack.Screen name="auth-callback" />
      </Stack>

      {/* Covers the signed-in app while a just-finished onboarding is saved
          to the new account, which ends by opening the new group. A plain
          overlay rather than a screen, so the navigator underneath carries
          on undisturbed. */}
      {session && isFinishing ? (
        <View style={[StyleSheet.absoluteFill, styles.finishingOverlay]}>
          <ActivityIndicator color={Colors.accent} />
          <Text style={styles.finishingText}>Setting up your account…</Text>
        </View>
      ) : null}
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <ProfileProvider>
          <GroupsProvider>
            <LogsProvider>
              <OnboardingProvider>
                <RootNavigator />
              </OnboardingProvider>
            </LogsProvider>
          </GroupsProvider>
        </ProfileProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  finishingOverlay: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: Colors.background,
  },
  finishingText: {
    color: Colors.muted,
    fontSize: 15,
  },
});
