import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { extractSessionTokensFromUrl } from "@/utils/oauth";

// Only reached on web: signInWithOAuthProvider (utils/oauth.ts) lets
// supabase-js do a full-page redirect there, so the trip back to this app
// has to land on an actual route rather than being caught inline. Native
// never navigates here — WebBrowser.openAuthSessionAsync resolves with the
// redirect URL directly in memory, without the app ever unmounting.
export default function AuthCallbackScreen() {
  const url = Linking.useURL();

  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    async function establishSession() {
      const tokens = extractSessionTokensFromUrl(url as string);
      if (tokens) {
        await supabase.auth.setSession({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
        });
      }
      if (!cancelled) router.replace("/");
    }

    establishSession();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <View style={styles.container}>
      <ActivityIndicator color={Colors.accent} />
      <Text style={styles.text}>Signing you in...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  text: {
    color: Colors.muted,
    fontSize: 15,
  },
});
