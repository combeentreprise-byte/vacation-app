import { Stack } from "expo-router";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { GroupsProvider } from "@/hooks/use-groups";
import { LogsProvider } from "@/hooks/use-logs";
import { ProfileProvider } from "@/hooks/use-profile";

function RootNavigator() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return <View style={{ flex: 1 }} />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
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
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <ProfileProvider>
          <GroupsProvider>
            <LogsProvider>
              <RootNavigator />
            </LogsProvider>
          </GroupsProvider>
        </ProfileProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
