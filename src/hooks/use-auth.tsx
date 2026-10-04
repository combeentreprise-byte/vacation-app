import AsyncStorage from "@react-native-async-storage/async-storage";
import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import * as Linking from "expo-linking";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { SUPABASE_AUTH_STORAGE_KEY, supabase } from "@/lib/supabase";
import { signInWithOAuthProvider, type OAuthProvider } from "@/utils/oauth";
import { clearOfflineDataForUser } from "@/utils/offline-storage";
import { unregisterPushNotifications } from "@/utils/push-notifications";

// getSession() returns no session at all when the stored access token has
// expired and can't be refreshed because the device is offline — even
// though supabase-js deliberately keeps the session stored (a network
// failure isn't a rejected refresh token) and refreshes it on its own once
// the connection is back. Taking that at face value would bounce anyone
// opening the app offline more than an hour after last using it to the
// sign-in screen, which in turn can't work offline. So in exactly that case
// the stored session is read back directly and used as-is: requests made
// with it fail like any other offline request, and the auth listener swaps
// in the refreshed one as soon as the client manages to refresh it.
async function restoreOfflineSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Session) : null;
    return stored?.user && stored.refresh_token ? stored : null;
  } catch {
    return null;
  }
}

type AuthContextValue = {
  session: Session | null;
  isLoading: boolean;
  signUp: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; isEmailTaken?: boolean; isWeakPassword?: boolean }>;
  signIn: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; isInvalidCredentials?: boolean }>;
  signInWithOAuth: (provider: OAuthProvider) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  resetPasswordForEmail: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  deleteAccount: () => Promise<{ error: string | null }>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data, error }) => {
      let initialSession = data.session;
      if (!initialSession && isAuthRetryableFetchError(error)) {
        initialSession = await restoreOfflineSession();
      }
      setSession(initialSession);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // Carries the same result as the getSession() call above, minus its
      // offline fallback — letting it through would sign an offline user
      // straight back out.
      if (event === "INITIAL_SESSION") return;
      setSession(nextSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    // Stable error code (not the message string) for the UI to branch on —
    // only reliable because email confirmation is disabled on this project,
    // so signUp fails immediately for a known email instead of the generic
    // "check your email" response Supabase gives when confirmation is on
    // (which deliberately avoids revealing whether the account exists).
    return {
      error: error?.message ?? null,
      isEmailTaken: error?.code === "user_already_exists",
      isWeakPassword: error?.code === "weak_password",
    };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    // Supabase deliberately returns this same generic error whether the
    // email doesn't exist or the password is wrong (anti-enumeration), so
    // the UI can only flag "one of these two is wrong," never which one.
    return {
      error: error?.message ?? null,
      isInvalidCredentials: error?.code === "invalid_credentials",
    };
  };

  const signInWithOAuth = async (provider: OAuthProvider) => {
    return signInWithOAuthProvider(provider);
  };

  // Also wipes this account's data stored on the device (see
  // offline-storage.ts), including anything that never got to sync — the
  // sign-out UI warns about that first.
  const signOut = async () => {
    const userId = session?.user.id;
    // While still signed in: it's that account's to remove.
    await unregisterPushNotifications();
    const { error } = await supabase.auth.signOut();
    if (!error && userId) await clearOfflineDataForUser(userId);
  };

  const resetPasswordForEmail = async (email: string) => {
    // redirectTo has to be in the project's Auth > URL Configuration >
    // Redirect URLs allow-list in the Supabase dashboard, or Supabase drops
    // it and falls back to the default Site URL instead.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: Linking.createURL("reset-password"),
    });
    return { error: error?.message ?? null };
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return { error: error?.message ?? null };
  };

  // Runs delete_account (schema.sql), which leaves every group the user is
  // still in and then deletes their auth.users row outright — real erasure,
  // not a soft flag, which cascades to their profiles row too. That RPC call
  // alone doesn't invalidate this client's already-issued session token, so
  // signOut() here is what actually drops them back to signed-out state
  // rather than leaving a session pointing at a user that no longer exists.
  const deleteAccount = async () => {
    const userId = session?.user.id;
    const { error } = await supabase.rpc("delete_account");
    if (error) return { error: error.message };
    await supabase.auth.signOut();
    if (userId) await clearOfflineDataForUser(userId);
    return { error: null };
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoading,
        signUp,
        signIn,
        signInWithOAuth,
        signOut,
        resetPasswordForEmail,
        updatePassword,
        deleteAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
