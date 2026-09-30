import type { PlanPeriod } from "@/constants/plans";
import { supabase } from "@/lib/supabase";
import { showComingSoon } from "@/utils/coming-soon";
import { requestErrorMessage } from "@/utils/network";

// The one place buying goes through. Real store purchases don't exist yet,
// so for now buying is free, through test_purchase_plan/test_add_plan_seats,
// for whoever the server allows (everyone while billing_settings'
// free_test_purchases is on, otherwise its tester list) — and everyone else
// gets the coming-soon notice. Store purchases will slot in behind
// these same functions.

type PurchaseResult = { error?: string; unavailable?: boolean };

export async function purchasePlan(params: {
  canTestPurchase: boolean;
  // Null for "Just me".
  groupId: string | null;
  period: PlanPeriod;
  seatCount: number;
  // For a group plan: who gets its first seats.
  memberIds: string[];
}): Promise<PurchaseResult> {
  if (!params.canTestPurchase) {
    showComingSoon("Buying a plan");
    return { unavailable: true };
  }

  const { error, status } = await supabase.rpc("test_purchase_plan", {
    p_group_id: params.groupId,
    p_period: params.period,
    p_seat_count: params.seatCount,
    p_member_ids: params.memberIds,
  });

  if (error) {
    console.warn("Failed to buy plan", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return {};
}

// Makes a running group plan bigger and/or, for a 1-week Trip Pass, 2 weeks
// long (period "two_weeks"; null keeps its end date).
export async function upgradePlan(params: {
  canTestPurchase: boolean;
  planId: string;
  seatCount: number;
  period: PlanPeriod | null;
}): Promise<PurchaseResult> {
  if (!params.canTestPurchase) {
    showComingSoon("Upgrading a plan");
    return { unavailable: true };
  }

  const { error, status } = await supabase.rpc("test_upgrade_plan", {
    p_plan_id: params.planId,
    p_seat_count: params.seatCount,
    p_period: params.period,
  });

  if (error) {
    console.warn("Failed to upgrade plan", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return {};
}
