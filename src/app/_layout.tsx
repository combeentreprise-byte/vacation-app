import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GroupListSkeleton, GroupScreenSkeleton } from "@/components/screen-skeletons";
import { Colors } from "@/constants/colors";
import { AccessProvider } from "@/hooks/use-access";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { GroupsProvider } from "@/hooks/use-groups";
import { LogsProvider } from "@/hooks/use-logs";
import { NotificationsProvider, useOpenTappedNotifications } from "@/hooks/use-notifications";
import { OnboardingProvider, useOnboarding } from "@/hooks/use-onboarding";
import { ProfileProvider } from "@/hooks/use-profile";

// The native splash screen stays up until the stored session and onboarding
// state have been read (RootNavigator hides it), rather than giving way to
// a blank screen while they are.
SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, isLoading } = useAuth();
  const { isLoaded: isOnboardingLoaded, hasSignedInOnDevice, isFinishing, draft } =
    useOnboarding();
  const insets = useSafeAreaInsets();
  const isReady = !isLoading && isOnboardingLoaded;
  useOpenTappedNotifications(isReady && !!session);

  useEffect(() => {
    if (isReady) SplashScreen.hide();
  }, [isReady]);

  if (!isReady) {
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
          <Stack.Screen
            name="paywall"
            options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="plan-setup"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="group-plan"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="plans"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="subscription"
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
          to the new account, which ends by opening the new group (or stays
          on the group list without one) — so it's a skeleton of where it's
          going. A plain overlay rather than a screen, so the navigator
          underneath carries on undisturbed. */}
      {session && isFinishing ? (
        <View style={[StyleSheet.absoluteFill, styles.finishingOverlay]}>
          {draft.group ? (
            <GroupScreenSkeleton />
          ) : (
            <View style={{ paddingTop: insets.top }}>
              <GroupListSkeleton />
            </View>
          )}
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
            <AccessProvider>
              <LogsProvider>
                <NotificationsProvider>
                  <OnboardingProvider>
                    <RootNavigator />
                  </OnboardingProvider>
                </NotificationsProvider>
              </LogsProvider>
            </AccessProvider>
          </GroupsProvider>
        </ProfileProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  finishingOverlay: {
    backgroundColor: Colors.background,
  },
});
