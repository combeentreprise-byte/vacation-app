import { Stack } from "expo-router";
import { View } from "react-native";

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

      {/* Ungated: reached via a Supabase recovery email link, which can land
          before or after this client establishes its own session from the
          link's tokens, so it can't be gated on session state either way. */}
      <Stack.Screen name="reset-password" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <GroupsProvider>
          <LogsProvider>
            <RootNavigator />
          </LogsProvider>
        </GroupsProvider>
      </ProfileProvider>
    </AuthProvider>
  );
}
