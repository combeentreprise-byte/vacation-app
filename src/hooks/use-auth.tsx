import type { Session } from "@supabase/supabase-js";
import * as Linking from "expo-linking";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { supabase } from "@/lib/supabase";
import { signInWithOAuthProvider, type OAuthProvider } from "@/utils/oauth";

type AuthContextValue = {
  session: Session | null;
  isLoading: boolean;
  signUp: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; isEmailTaken?: boolean }>;
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
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
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

  const signOut = async () => {
    await supabase.auth.signOut();
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
    const { error } = await supabase.rpc("delete_account");
    if (error) return { error: error.message };
    await supabase.auth.signOut();
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
