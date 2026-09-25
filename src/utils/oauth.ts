import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { supabase } from "@/lib/supabase";

// Lets the in-app browser sheet on native close itself once Supabase
// redirects back to our scheme, instead of leaving a dead tab open.
WebBrowser.maybeCompleteAuthSession();

export type OAuthProvider = "google" | "apple";

// Both OAuth and password-recovery redirects land here: this client uses the
// default "implicit" auth flow and detectSessionInUrl is off (see
// lib/supabase.ts, needed for SSR safety), so tokens arrive as a URL
// fragment (`#access_token=...&refresh_token=...`) that nothing parses
// automatically — every redirect has to do this by hand.
export function extractSessionTokensFromUrl(url: string) {
  const fragment = url.split("#")[1] ?? url.split("?")[1];
  if (!fragment) return null;

  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}

export async function signInWithOAuthProvider(provider: OAuthProvider) {
  const redirectTo = Linking.createURL("auth-callback");

  if (Platform.OS === "web") {
    // supabase-js does a full-page redirect itself on web; the trip back is
    // handled by app/auth-callback.tsx reading the returned URL fragment.
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    return { error: error?.message ?? null };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    return { error: error?.message ?? "Couldn't start sign-in" };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type === "cancel" || result.type === "dismiss") {
    return { error: null };
  }
  if (result.type !== "success" || !result.url) {
    return { error: "Sign-in was cancelled" };
  }

  const tokens = extractSessionTokensFromUrl(result.url);
  if (!tokens) return { error: "Couldn't complete sign-in" };

  const { error: sessionError } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  return { error: sessionError?.message ?? null };
}
