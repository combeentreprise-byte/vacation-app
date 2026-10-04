import type { MyAccess } from "@/hooks/use-access";
import type { GroupAccess, MemberAccess } from "@/hooks/use-group-access";

const DAY_MS = 24 * 60 * 60 * 1000;
// How close to its end an unlock gets pointed out next to someone's name.
const ENDS_SOON_MS = 3 * DAY_MS;

// When a Trip Pass running `days` from `startsAt` would end — for lining it
// up against people's current unlocks while setting it up.
export function planEndsAt(startsAt: number, days: number) {
  return startsAt + days * DAY_MS;
}

// Whether a plan set up to start at `startsAt` is still waiting to start.
export function isNotStartedYet(startsAt: number | null | undefined, now = Date.now()) {
  return startsAt != null && startsAt > now;
}

// Whether someone whose unlock runs until `unlockedUntil` is unlocked at `at`.
export function isUnlockedAt(unlockedUntil: number | null | undefined, at = Date.now()) {
  return unlockedUntil != null && unlockedUntil > at;
}

// Whether someone's current unlock still covers `at`, which may be ahead
// (when a pass would start or end). One that renews by itself covers any
// date: a subscription is treated as if it's never cancelled — the mirror
// of unlocked_on in schema.sql.
export function isCoveredAt(member: MemberAccess | undefined, at = Date.now()) {
  if (!member || !isUnlockedAt(member.unlockedUntil)) return false;
  return member.willRenew || isUnlockedAt(member.unlockedUntil, at);
}

// Whether the viewer has nothing unlocking them at `now` (a renewing
// subscription counts, even just past its end, until it's re-fetched).
export function isViewerLocked(access: MyAccess, now = Date.now()) {
  const covering = access.coveringPlan;
  return !covering || !(covering.willRenew || isUnlockedAt(covering.endsAt, now));
}

export function isMemberUnlocked(access: GroupAccess | null, userId: string, at = Date.now()) {
  return isUnlockedAt(access?.members[userId]?.unlockedUntil, at);
}

// The group's free entries left (one pool, shared by everyone in it) once
// this device's not-yet-synced entries in it are counted too — the server
// only counts what has reached it. Pessimistic: a pending entry with everyone
// on it unlocked won't actually use one.
export function freeEntriesLeft(access: GroupAccess | null, pendingInGroup: number) {
  return Math.max(0, (access?.freeEntriesLeft ?? 0) - pendingInGroup);
}

// Whether entries in this group need everyone on them unlocked right now (its
// free entries are used up) — the client-side mirror of check_entry_access
// in schema.sql. Access that
// hasn't loaded yet (null) never blocks anything: the server has the final
// say either way, and an entry it turns down is held on the device rather
// than lost (see use-logs.tsx).
export function entriesNeedUnlock(access: GroupAccess | null, pendingInGroup: number) {
  return !!access && access.paywallEnabled && freeEntriesLeft(access, pendingInGroup) === 0;
}

// Worth pointing out next to someone's name: their unlock runs out before
// the group's plan does (so mid-trip), or within the next few days. Never for
// one that renews by itself.
export function unlockEndsEarly(
  member: MemberAccess | undefined,
  planEndsAt: number | null,
  now = Date.now()
) {
  if (!member || !isUnlockedAt(member.unlockedUntil, now) || member.willRenew) return false;
  const until = member.unlockedUntil as number;
  if (planEndsAt !== null && until < planEndsAt) return true;
  return until - now < ENDS_SOON_MS;
}

// Near its end, a plan's end date turns into a countdown instead: within 3
// days for a Trip Pass, 5 for a monthly subscription and a week for a yearly
// one. Told apart by length alone, so it also works for someone's unlock,
// which doesn't say what kind of plan it comes from.
function countdownWindowDays(durationDays: number) {
  if (durationDays <= 14) return 3;
  if (durationDays <= 31) return 5;
  return 7;
}

// "3 days left until pass runs out", "5 days left until renewal" — or
// `fallback` (the usual "until 7 Oct") while the end isn't near yet, or the
// plan's length isn't known. Counted in calendar days (ending on Friday is
// "3 days left" all of Tuesday), never fewer than 1.
export function formatPlanEnd(
  endsAt: number,
  willRenew: boolean,
  durationDays: number | null | undefined,
  fallback: string,
  now = Date.now()
) {
  if (durationDays == null || endsAt <= now) return fallback;
  const daysLeft = Math.max(
    1,
    Math.round((startOfLocalDay(endsAt) - startOfLocalDay(now)) / DAY_MS)
  );
  if (daysLeft > countdownWindowDays(durationDays)) return fallback;
  const left = `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
  if (durationDays <= 14) return `${left} until pass runs out`;
  return willRenew ? `${left} until renewal` : `${left} until subscription runs out`;
}

function startOfLocalDay(ms: number) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// "7 Oct", or "7 Oct 2027" once it's not this year. Always English, like the
// rest of the app's text — the device's own locale would drop e.g. a German
// "7. Okt." into an English sentence.
export function formatAccessDate(ms: number) {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-GB", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// "Sam", "Sam and Kim", "Sam, Kim and Lea" — the same joining check_entry_access
// uses for its own message.
// With `max`, names past it collapse into a count: "Anna, Ben +3".
export function joinNames(names: string[], max?: number) {
  if (max !== undefined && names.length > max) {
    return `${names.slice(0, max).join(", ")} +${names.length - max}`;
  }
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
