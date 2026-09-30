import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { FREE_ENTRIES_PER_USER } from "@/constants/limits";
import type { PlanKind } from "@/constants/plans";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { readUserData, writeUserData } from "@/utils/offline-storage";

// The plan whose seat currently unlocks the viewer — the longest-lasting
// one, if several do.
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
  endsAt: number;
  willRenew: boolean;
};

export type MyAccess = {
  // Off until the paywall is switched on server-side: everyone can add
  // entries, and none of the plan UI shows (except to those who can make
  // test purchases).
  paywallEnabled: boolean;
  freeEntriesPerUser: number;
  // Can make free test purchases, until real store purchases exist.
  canTestPurchase: boolean;
  coveringPlan: CoveringPlan | null;
  // Longest-lasting first.
  activePlans: ActivePlan[];
};

type CoveringPlanRow = {
  id: string;
  kind: PlanKind;
  group_id: string | null;
  sponsor_id: string | null;
  sponsor_name: string | null;
  ends_at: string;
  will_renew: boolean;
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
  ends_at: string;
  will_renew: boolean;
};

type MyAccessRow = {
  paywall_enabled: boolean;
  free_entries_per_user: number;
  can_test_purchase: boolean;
  covering_plan: CoveringPlanRow | null;
  active_plans: ActivePlanRow[];
};

function mapAccess(row: MyAccessRow): MyAccess {
  const covering = row.covering_plan;
  return {
    paywallEnabled: row.paywall_enabled,
    freeEntriesPerUser: row.free_entries_per_user,
    canTestPurchase: row.can_test_purchase,
    coveringPlan: covering
      ? {
          id: covering.id,
          kind: covering.kind,
          groupId: covering.group_id,
          sponsorId: covering.sponsor_id,
          sponsorName: covering.sponsor_name,
          endsAt: new Date(covering.ends_at).getTime(),
          willRenew: covering.will_renew,
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
      endsAt: new Date(plan.ends_at).getTime(),
      willRenew: plan.will_renew,
    })),
  };
}

// Until the server has answered once: the paywall treated as off, so nothing
// is ever blocked on a guess — the server decides either way.
const INITIAL_ACCESS: MyAccess = {
  paywallEnabled: false,
  freeEntriesPerUser: FREE_ENTRIES_PER_USER,
  canTestPurchase: false,
  coveringPlan: null,
  activePlans: [],
};

type AccessContextValue = {
  access: MyAccess;
  // Whether any plan UI shows at all: always once the paywall is on, and for
  // testers before that, so plans can be tried out without locking anyone.
  plansVisible: boolean;
  isLoaded: boolean;
  refresh: () => Promise<void>;
};

const AccessContext = createContext<AccessContextValue | undefined>(undefined);

export function AccessProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [access, setAccess] = useState<MyAccess>(INITIAL_ACCESS);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setAccess(INITIAL_ACCESS);
      setIsLoaded(true);
      return;
    }

    const { data, error } = await supabase.rpc("get_my_access");

    if (error) {
      // Offline: keep showing what's there (see use-groups.tsx's refresh).
      console.warn("Failed to load access", error);
    } else {
      const next = mapAccess(data as MyAccessRow);
      setAccess(next);
      writeUserData(userId, "access", next);
    }
    setIsLoaded(true);
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
          setIsLoaded(true);
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
