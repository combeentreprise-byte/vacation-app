import NetInfo from "@react-native-community/netinfo";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { type MyAccess, useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { isViewerLocked } from "@/utils/access";
import { readUserData, writeUserData } from "@/utils/offline-storage";
import { canBuyPlans } from "@/utils/purchases";

// Opens /paywall on its own, now and then, for people who are still locked.
// Two kinds of nudge share one record of when the last one was shown:
// - every so often, from the group list (usePaywallNudge): the wait between
//   them grows with each one shown (NUDGE_COOLDOWNS_MS), so it never turns
//   into a pop-up on every launch;
// - once per group as its shared free entries run low and once more when
//   they're gone (useFreeEntriesNudge, on the group screen) — the moment
//   the limit is actually felt. These ignore the cooldown, but still keep
//   MIN_NUDGE_GAP_MS from any other nudge.
// Nobody who is about to be unlocked anyway is nudged: holding a seat on, or
// sponsoring, a pass that starts later, or having bought one that isn't set
// up yet. Kept on the device only (wiped on sign-out with everything else),
// so a second device keeps its own count.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Nothing in a new account's first day, so onboarding and inviting the first
// group happen undisturbed.
const SIGN_UP_GRACE_MS = DAY_MS;
// The wait after the 1st, 2nd and 3rd-or-later nudge.
const NUDGE_COOLDOWNS_MS = [DAY_MS, 3 * DAY_MS, 7 * DAY_MS];
const MIN_NUDGE_GAP_MS = HOUR_MS;
// Free entries left in a group at which it nudges, highest first.
const FREE_ENTRY_THRESHOLDS = [5, 0];
// Lets the screen it opens from finish its own entrance first.
const OPEN_DELAY_MS = 800;
const STORAGE_NAME = "paywall-nudge";

type NudgeState = {
  lastShownAt: number | null;
  shownCount: number;
  // Per group, the FREE_ENTRY_THRESHOLDS it has already nudged at.
  freeEntryThresholds: Record<string, number[]>;
};

const INITIAL_STATE: NudgeState = { lastShownAt: null, shownCount: 0, freeEntryThresholds: {} };

// So two triggers firing together (focus and foreground) open it only once.
let isNudging = false;

function isAboutToBeUnlocked(access: MyAccess) {
  // Every plan listed here is one they sponsor or hold a seat on.
  return access.upcomingPlans.length > 0;
}

// Whether the viewer can be nudged at all — null if not, else a check for
// what depends on the moment (still locked, past the sign-up grace).
function useNudgeEligibility() {
  const { session } = useAuth();
  const { access, isFresh } = useAccess();
  const createdAt = session?.user.created_at ? new Date(session.user.created_at).getTime() : null;

  return useMemo(() => {
    if (
      !isFresh ||
      !access.paywallEnabled ||
      !canBuyPlans(access) ||
      isAboutToBeUnlocked(access) ||
      createdAt === null
    ) {
      return null;
    }
    return (now: number) => isViewerLocked(access, now) && now - createdAt >= SIGN_UP_GRACE_MS;
  }, [isFresh, access, createdAt]);
}

// Reads the record, lets `decide` pick what to open (or nothing) and how the
// record changes, then saves it and opens the paywall.
async function nudge(
  userId: string,
  isEligibleAt: (now: number) => boolean,
  decide: (state: NudgeState, now: number) => { state: NudgeState; params: Record<string, string> } | null
) {
  if (isNudging) return;
  isNudging = true;
  try {
    const network = await NetInfo.fetch();
    if (!network.isConnected || network.isInternetReachable === false) return;
    const now = Date.now();
    if (!isEligibleAt(now)) return;
    const stored = await readUserData<NudgeState>(userId, STORAGE_NAME);
    const result = decide({ ...INITIAL_STATE, ...stored }, now);
    if (!result) return;
    await writeUserData(userId, STORAGE_NAME, result.state);
    router.push({ pathname: "/paywall", params: result.params });
  } finally {
    isNudging = false;
  }
}

// When the paywall last opened on its own (so the review prompt can keep
// clear of it), or null if it never has on this device.
export async function lastPaywallNudgeAt(userId: string) {
  return (await readUserData<NudgeState>(userId, STORAGE_NAME))?.lastShownAt ?? null;
}

function shownNow(state: NudgeState, now: number): NudgeState {
  return { ...state, lastShownAt: now, shownCount: state.shownCount + 1 };
}

// The first nudge explains plans (for someone who has never had one, as
// /paywall decides); after that, straight to the prices.
function paywallParams(state: NudgeState, groupId?: string) {
  return {
    ...(state.shownCount > 0 ? { pricingOnly: "1" } : {}),
    ...(groupId ? { groupId } : {}),
  };
}

// Runs `check` a moment after the screen is focused, again whenever it or
// `rerunOn` changes while it is, and calls `onForeground` when the app
// returns to the foreground on it.
function useWhileFocused(
  check: () => void,
  options: { rerunOn?: unknown; onForeground?: () => void } = {}
) {
  const { rerunOn, onForeground } = options;
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!isFocused) return;
    const timeout = setTimeout(check, OPEN_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [isFocused, check, rerunOn]);

  useEffect(() => {
    if (!isFocused || !onForeground) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") onForeground();
    });
    return () => subscription.remove();
  }, [isFocused, onForeground]);
}

// The every-so-often nudge, for the group list. Coming back to the app
// re-fetches access first, which then re-runs the check.
export function usePaywallNudge() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const { access, refresh } = useAccess();
  const eligibility = useNudgeEligibility();

  const check = useCallback(() => {
    if (!eligibility || !userId) return;
    nudge(userId, eligibility, (state, now) => {
      if (state.lastShownAt !== null) {
        const cooldown =
          NUDGE_COOLDOWNS_MS[Math.min(state.shownCount, NUDGE_COOLDOWNS_MS.length) - 1] ?? 0;
        if (now - state.lastShownAt < Math.max(cooldown, MIN_NUDGE_GAP_MS)) return null;
      }
      return { state: shownNow(state, now), params: paywallParams(state) };
    });
  }, [eligibility, userId]);

  // A re-fetch (on returning to the app) runs it again, even when nothing
  // in it changed: time has passed.
  useWhileFocused(check, { rerunOn: access, onForeground: refresh });
}

// The free-entries nudge, for the group screen: `freeEntriesLeft` is the
// group's count (null until it has loaded), and opening a group already
// past several thresholds nudges only once for all of them.
export function useFreeEntriesNudge(groupId: string | undefined, freeEntriesLeft: number | null) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const eligibility = useNudgeEligibility();

  const check = useCallback(() => {
    if (!eligibility || !userId || !groupId || freeEntriesLeft === null) return;
    const reached = FREE_ENTRY_THRESHOLDS.filter((threshold) => freeEntriesLeft <= threshold);
    if (reached.length === 0) return;
    nudge(userId, eligibility, (state, now) => {
      const shown = state.freeEntryThresholds[groupId] ?? [];
      if (reached.every((threshold) => shown.includes(threshold))) return null;
      if (state.lastShownAt !== null && now - state.lastShownAt < MIN_NUDGE_GAP_MS) return null;
      return {
        state: {
          ...shownNow(state, now),
          freeEntryThresholds: {
            ...state.freeEntryThresholds,
            [groupId]: [...new Set([...shown, ...reached])],
          },
        },
        params: paywallParams(state, groupId),
      };
    });
  }, [eligibility, userId, groupId, freeEntriesLeft]);

  useWhileFocused(check);
}
