import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { FREE_ENTRIES_PER_GROUP } from "@/constants/limits";
import type { PlanKind, PlanSource } from "@/constants/plans";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { readUserData, writeUserData } from "@/utils/offline-storage";

// The plan whose seat currently unlocks the viewer — the longest-lasting
// one, if several do, with a renewing subscription counting as never
// running out.
export type CoveringPlan = {
  id: string;
  kind: PlanKind;
  // Null for a "Just me" plan.
  groupId: string | null;
  // Null once the sponsor has deleted their account.
  sponsorId: string | null;
  sponsorName: string | null;
  endsAt: number;
  willRenew: boolean;
  // How long it runs (a subscription's term), for how early its end gets
  // pointed out. Null in a copy saved on the device before this existed.
  durationDays: number | null;
};

// A running plan the viewer sponsors, holds a seat on, or both.
export type ActivePlan = {
  id: string;
  kind: PlanKind;
  // Null for a "Just me" plan (or once its group has been deleted — then
  // groupName is null too).
  groupId: string | null;
  groupName: string | null;
  sponsorId: string | null;
  sponsorName: string | null;
  hasSeat: boolean;
  seatCount: number;
  seatsUsed: number;
  // Null in a copy saved on the device before this existed (as is source;
  // billingDates is missing there).
  startsAt: number | null;
  endsAt: number;
  willRenew: boolean;
  // How long it runs (a subscription's term), for how early its end gets
  // pointed out. Null in a copy saved on the device before this existed.
  durationDays: number | null;
  source: PlanSource | null;
  // A subscription's charges so far — the start of every term, oldest
  // first. Empty for a Trip Pass.
  billingDates?: number[];
};

// A Trip Pass of the viewer's that hasn't started: bought but not set up yet
// (startsAt null — only ever the viewer's own), or set up to start later.
export type UpcomingPlan = {
  id: string;
  kind: PlanKind;
  // Null for "Just me", and for a group pass that isn't set up yet.
  groupId: string | null;
  groupName: string | null;
  sponsorId: string | null;
  sponsorName: string | null;
  hasSeat: boolean;
  seatCount: number;
  seatsUsed: number;
  startsAt: number | null;
  endsAt: number | null;
  // How long it runs once started.
  durationDays: number;
};

// A plan that has ended which the viewer sponsored or held a seat on.
export type PastPlan = {
  id: string;
  kind: PlanKind;
  groupId: string | null;
  groupName: string | null;
  sponsorId: string | null;
  sponsorName: string | null;
  seatCount: number;
  startsAt: number;
  endsAt: number;
  durationDays: number;
};

type PastPlanRow = {
  id: string;
  kind: PlanKind;
  group_id: string | null;
  group_name: string | null;
  sponsor_id: string | null;
  sponsor_name: string | null;
  seat_count: number;
  starts_at: string;
  ends_at: string;
  duration_days: number;
};

export type MyAccess = {
  // Off until the paywall is switched on server-side: everyone can add
  // entries, and none of the plan UI shows (except to those who can make
  // test purchases).
  paywallEnabled: boolean;
  // Free entries each group shares before entries need everyone unlocked.
  freeEntriesPerGroup: number;
  // Can make free test purchases, until real store purchases exist.
  canTestPurchase: boolean;
  // Has ever bought a plan or held a seat on one (ended ones included). The
  // paywall only explains plans to people who haven't.
  hasHadPlan: boolean;
  coveringPlan: CoveringPlan | null;
  // Longest-lasting first.
  activePlans: ActivePlan[];
  // Not set up first, then soonest to start.
  upcomingPlans: UpcomingPlan[];
  // Ended, most recently first (the last 50).
  pastPlans: PastPlan[];
  // The viewer's groups that already have a plan that hasn't ended (running
  // or still to start). A group can only have one at a time, so a pass being
  // set up can't go to these.
  groupsWithPlans: { groupId: string; startsAt: number; endsAt: number }[];
};

type CoveringPlanRow = {
  id: string;
  kind: PlanKind;
  group_id: string | null;
  sponsor_id: string | null;
  sponsor_name: string | null;
  ends_at: string;
  will_renew: boolean;
  duration_days?: number;
};

type ActivePlanRow = {
  id: string;
  kind: PlanKind;
  group_id: string | null;
  group_name: string | null;
  sponsor_id: string | null;
  sponsor_name: string | null;
  has_seat: boolean;
  seat_count: number;
  seats_used: number;
  starts_at?: string;
  ends_at: string;
  will_renew: boolean;
  duration_days?: number;
  source?: PlanSource;
  billing_dates?: string[] | null;
};

type UpcomingPlanRow = {
  id: string;
  kind: PlanKind;
  group_id: string | null;
  group_name: string | null;
  sponsor_id: string | null;
  sponsor_name: string | null;
  has_seat: boolean;
  seat_count: number;
  seats_used: number;
  starts_at: string | null;
  ends_at: string | null;
  duration_days: number;
};

type MyAccessRow = {
  paywall_enabled: boolean;
  free_entries_per_group: number;
  can_test_purchase: boolean;
  has_had_plan: boolean;
  covering_plan: CoveringPlanRow | null;
  active_plans: ActivePlanRow[];
  upcoming_plans: UpcomingPlanRow[];
  // Missing from a copy saved on the device before this existed.
  past_plans?: PastPlanRow[];
  groups_with_plans: { group_id: string; starts_at: string; ends_at: string }[];
};

function mapAccess(row: MyAccessRow): MyAccess {
  const covering = row.covering_plan;
  return {
    paywallEnabled: row.paywall_enabled,
    freeEntriesPerGroup: row.free_entries_per_group,
    canTestPurchase: row.can_test_purchase,
    hasHadPlan: row.has_had_plan,
    coveringPlan: covering
      ? {
          id: covering.id,
          kind: covering.kind,
          groupId: covering.group_id,
          sponsorId: covering.sponsor_id,
          sponsorName: covering.sponsor_name,
          endsAt: new Date(covering.ends_at).getTime(),
          willRenew: covering.will_renew,
          durationDays: covering.duration_days ?? null,
        }
      : null,
    activePlans: row.active_plans.map((plan) => ({
      id: plan.id,
      kind: plan.kind,
      groupId: plan.group_id,
      groupName: plan.group_name,
      sponsorId: plan.sponsor_id,
      sponsorName: plan.sponsor_name,
      hasSeat: plan.has_seat,
      seatCount: plan.seat_count,
      seatsUsed: plan.seats_used,
      startsAt: plan.starts_at ? new Date(plan.starts_at).getTime() : null,
      endsAt: new Date(plan.ends_at).getTime(),
      willRenew: plan.will_renew,
      durationDays: plan.duration_days ?? null,
      source: plan.source ?? null,
      billingDates: (plan.billing_dates ?? []).map((date) => new Date(date).getTime()),
    })),
    upcomingPlans: row.upcoming_plans.map((plan) => ({
      id: plan.id,
      kind: plan.kind,
      groupId: plan.group_id,
      groupName: plan.group_name,
      sponsorId: plan.sponsor_id,
      sponsorName: plan.sponsor_name,
      hasSeat: plan.has_seat,
      seatCount: plan.seat_count,
      seatsUsed: plan.seats_used,
      startsAt: plan.starts_at ? new Date(plan.starts_at).getTime() : null,
      endsAt: plan.ends_at ? new Date(plan.ends_at).getTime() : null,
      durationDays: plan.duration_days,
    })),
    pastPlans: (row.past_plans ?? []).map((plan) => ({
      id: plan.id,
      kind: plan.kind,
      groupId: plan.group_id,
      groupName: plan.group_name,
      sponsorId: plan.sponsor_id,
      sponsorName: plan.sponsor_name,
      seatCount: plan.seat_count,
      startsAt: new Date(plan.starts_at).getTime(),
      endsAt: new Date(plan.ends_at).getTime(),
      durationDays: plan.duration_days,
    })),
    groupsWithPlans: row.groups_with_plans.map((item) => ({
      groupId: item.group_id,
      startsAt: new Date(item.starts_at).getTime(),
      endsAt: new Date(item.ends_at).getTime(),
    })),
  };
}

// Until the server has answered once: the paywall treated as off, so nothing
// is ever blocked on a guess — the server decides either way.
const INITIAL_ACCESS: MyAccess = {
  paywallEnabled: false,
  freeEntriesPerGroup: FREE_ENTRIES_PER_GROUP,
  canTestPurchase: false,
  hasHadPlan: false,
  coveringPlan: null,
  activePlans: [],
  upcomingPlans: [],
  pastPlans: [],
  groupsWithPlans: [],
};

type AccessContextValue = {
  access: MyAccess;
  // Whether any plan UI shows at all: always once the paywall is on, and for
  // testers before that, so plans can be tried out without locking anyone.
  plansVisible: boolean;
  isLoaded: boolean;
  // Whether the last fetch from the server succeeded, as opposed to showing
  // only the device's copy (offline) — for anything that shouldn't act on a
  // possibly stale copy, like nudging toward the paywall someone who may
  // have bought a plan on another device.
  isFresh: boolean;
  refresh: () => Promise<void>;
};

const AccessContext = createContext<AccessContextValue | undefined>(undefined);

export function AccessProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [access, setAccess] = useState<MyAccess>(INITIAL_ACCESS);
  // Which account (null = signed out) the data above has loaded for, so
  // isLoaded reads false again while a newly signed-in account's is still
  // loading, rather than carrying over from the signed-out state (same as
  // use-profile.tsx).
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const isLoaded = loadedFor === userId;
  const [freshFor, setFreshFor] = useState<string | null>(null);
  const isFresh = userId !== null && freshFor === userId;

  const refresh = useCallback(async () => {
    if (!userId) {
      setAccess(INITIAL_ACCESS);
      setLoadedFor(userId);
      return;
    }

    const { data, error } = await supabase.rpc("get_my_access");

    if (error) {
      // Offline: keep showing what's there (see use-groups.tsx's refresh).
      console.warn("Failed to load access", error);
      setFreshFor(null);
    } else {
      const next = mapAccess(data as MyAccessRow);
      setAccess(next);
      setFreshFor(userId);
      writeUserData(userId, "access", next);
    }
    setLoadedFor(userId);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // The device's last known copy first (see use-groups.tsx's load for
      // why), so a plan keeps showing — and the entry form keeps knowing
      // whether you're unlocked — with no connection.
      if (userId) {
        const stored = await readUserData<MyAccess>(userId, "access");
        if (cancelled) return;
        if (stored) {
          // Over the defaults, so a copy saved by an older build that lacks a
          // newer field still has it.
          setAccess({ ...INITIAL_ACCESS, ...stored });
          setLoadedFor(userId);
        }
      } else {
        setAccess(INITIAL_ACCESS);
      }
      if (cancelled) return;
      await refresh();
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [userId, refresh]);

  return (
    <AccessContext.Provider
      value={{
        access,
        plansVisible: access.paywallEnabled || access.canTestPurchase,
        isLoaded,
        isFresh,
        refresh,
      }}
    >
      {children}
    </AccessContext.Provider>
  );
}

export function useAccess() {
  const context = useContext(AccessContext);
  if (!context) {
    throw new Error("useAccess must be used within an AccessProvider");
  }
  return context;
}
