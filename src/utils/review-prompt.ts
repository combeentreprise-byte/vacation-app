import * as StoreReview from "expo-store-review";
import { AppState, Platform } from "react-native";

import { lastPaywallNudgeAt } from "@/hooks/use-paywall-nudge";
import { readUserData, writeUserData } from "@/utils/offline-storage";

// Asks for an App Store / Play Store rating with the OS's own popup, right
// after something went well: a debt settled up, or an entry synced once
// they've added a few (ENTRIES_BEFORE_ASKING). Never from a button — Apple
// and Google both say not to, and the OS may show nothing anyway (Apple at
// most 3 times a year, and we're never told whether it appeared). Does
// nothing on web and in TestFlight (isAvailableAsync is false there).
// Kept on the device only, like the paywall nudge's record.

const DAY_MS = 24 * 60 * 60 * 1000;
// Long enough to have actually used the app on a trip.
const SIGN_UP_GRACE_MS = 3 * DAY_MS;
// Spends Apple's 3-a-year allowance slowly, so a later ask still shows.
const ASK_COOLDOWN_MS = 120 * DAY_MS;
// Never right after the paywall opened on its own, so the two don't pile up.
const PAYWALL_NUDGE_GAP_MS = DAY_MS;
const ENTRIES_BEFORE_ASKING = 10;
// Lets the screen settle first (the settle-up popup closing, the entry
// form's dismissal).
const ASK_DELAY_MS = 1500;
const STORAGE_NAME = "review-prompt";

type ReviewPromptState = {
  lastAskedAt: number | null;
  // Entries of theirs that have reached the server, counted from here on.
  syncedEntries: number;
};

const INITIAL_STATE: ReviewPromptState = { lastAskedAt: null, syncedEntries: 0 };

// So two good moments at once ask only once.
let isAsking = false;

async function readState(userId: string): Promise<ReviewPromptState> {
  return { ...INITIAL_STATE, ...(await readUserData<ReviewPromptState>(userId, STORAGE_NAME)) };
}

async function maybeAsk(userId: string, accountCreatedAt: string | undefined) {
  if (Platform.OS === "web" || isAsking || !accountCreatedAt) return;
  isAsking = true;
  try {
    const now = Date.now();
    if (now - new Date(accountCreatedAt).getTime() < SIGN_UP_GRACE_MS) return;
    const state = await readState(userId);
    if (state.lastAskedAt !== null && now - state.lastAskedAt < ASK_COOLDOWN_MS) return;
    const paywallNudgedAt = await lastPaywallNudgeAt(userId);
    if (paywallNudgedAt !== null && now - paywallNudgedAt < PAYWALL_NUDGE_GAP_MS) return;
    if (!(await StoreReview.isAvailableAsync())) return;

    await new Promise((resolve) => setTimeout(resolve, ASK_DELAY_MS));
    // They switched away in the meantime: wait for the next good moment.
    if (AppState.currentState !== "active") return;
    // Re-read: an entry may have synced (and been counted) during the wait.
    await writeUserData(userId, STORAGE_NAME, {
      ...(await readState(userId)),
      lastAskedAt: Date.now(),
    });
    await StoreReview.requestReview();
  } catch (error) {
    console.warn("Failed to ask for a review", error);
  } finally {
    isAsking = false;
  }
}

// A debt was just settled up.
export function onDebtSettled(userId: string, accountCreatedAt: string | undefined) {
  return maybeAsk(userId, accountCreatedAt);
}

// `count` of their queued entries just reached the server. `canAsk` is false
// when others in the same sync were rejected or held: they're still counted,
// but the ask waits for a moment that went entirely well.
export async function onEntriesSynced(
  userId: string,
  accountCreatedAt: string | undefined,
  count: number,
  { canAsk }: { canAsk: boolean }
) {
  if (Platform.OS === "web" || count === 0) return;
  const state = await readState(userId);
  const syncedEntries = state.syncedEntries + count;
  await writeUserData(userId, STORAGE_NAME, { ...state, syncedEntries });
  if (canAsk && syncedEntries >= ENTRIES_BEFORE_ASKING) await maybeAsk(userId, accountCreatedAt);
}
