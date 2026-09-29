import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Check your .env file."
  );
}

// Expo Router's web output pre-renders pages in Node (dev and build), where
// `window` doesn't exist. The Supabase client tries to recover a persisted
// session as soon as it's constructed, which would otherwise crash the
// server the instant this module loads. Session persistence only makes
// sense in an actual client runtime anyway, so it's disabled on the server.
const isServer = typeof window === "undefined";

// Where the client persists its session — supabase-js's own default key,
// spelled out only so use-auth.tsx can read the stored session directly
// when the client itself won't hand it back (see restoreOfflineSession).
export const SUPABASE_AUTH_STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: isServer ? undefined : AsyncStorage,
    storageKey: SUPABASE_AUTH_STORAGE_KEY,
    autoRefreshToken: !isServer,
    persistSession: !isServer,
    detectSessionInUrl: false,
  },
});
