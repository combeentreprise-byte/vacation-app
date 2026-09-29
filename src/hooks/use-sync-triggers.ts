import NetInfo from "@react-native-community/netinfo";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { supabase } from "@/lib/supabase";

// While there's something queued, keep poking at it this often even without
// a connectivity change — NetInfo can report "connected" on a network that
// can't actually reach the server (captive portal, flaky hotel wifi), which
// fires no further event once it does start working.
const RETRY_INTERVAL_MS = 30_000;

// Calls `sync` whenever there's a reasonable chance a queued offline change
// can now go through: the connection comes back, the app returns to the
// foreground, or (while `hasPending`) every RETRY_INTERVAL_MS.
export function useSyncTriggers(sync: () => void, hasPending: boolean) {
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) syncRef.current();
    });
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") syncRef.current();
    });
    // An access token that expired while offline stays unusable for a while
    // after the connection returns (supabase-js waits out a cooldown after a
    // failed refresh before trying again), so the reconnect itself may be
    // too early to sync — this catches the moment it actually becomes usable.
    const { data: authSubscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === "TOKEN_REFRESHED") syncRef.current();
    });
    return () => {
      unsubscribeNetInfo();
      appStateSubscription.remove();
      authSubscription.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!hasPending) return;
    const interval = setInterval(() => syncRef.current(), RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasPending]);
}
