import type { PlanPeriod, PlanSource } from "@/constants/plans";
import { supabase } from "@/lib/supabase";
import { showComingSoon } from "@/utils/coming-soon";
import { requestErrorMessage } from "@/utils/network";

// The one place buying goes through. Real store purchases don't exist yet,
// so for now buying is free, through test_purchase_plan/test_upgrade_plan,
// for whoever the server allows (everyone while billing_settings'
// free_test_purchases is on, otherwise its tester list) — and everyone else
// gets the coming-soon notice. Store purchases will slot in behind
// these same functions.

type PurchaseResult = { error?: string; unavailable?: boolean };

// Whether buying would actually work here, rather than end in the
// coming-soon notice — so nothing pushes the paywall on someone who can't
// buy from it. Store purchases will widen this (but never to the web build,
// which can't use them).
export function canBuyPlans(params: { canTestPurchase: boolean }) {
  return params.canTestPurchase;
}

// A subscription is always "Just me" and starts right away. A Trip Pass of
// any size is bought not set up yet (no group, no start), and its id comes
// back so the buyer can go straight on to set it up (/plan-setup).
export async function purchasePlan(params: {
  canTestPurchase: boolean;
  period: PlanPeriod;
  seatCount: number;
}): Promise<PurchaseResult & { planId?: string }> {
  if (!params.canTestPurchase) {
    showComingSoon("Buying a plan");
    return { unavailable: true };
  }

  const { data, error, status } = await supabase.rpc("test_purchase_plan", {
    p_period: params.period,
    p_seat_count: params.seatCount,
  });

  if (error) {
    console.warn("Failed to buy plan", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return { planId: (data as { id: string }).id };
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

// Cancels a running subscription (it runs to the end of the term it's in,
// then ends) or takes that back. A test one changes through
// test_set_plan_renewal; a store one will open the store's own subscription
// settings, since only the store can stop its charges.
export async function setSubscriptionRenewal(params: {
  planId: string;
  source: PlanSource | null;
  willRenew: boolean;
}): Promise<PurchaseResult> {
  if (params.source !== "test") {
    showComingSoon(params.willRenew ? "Resuming a subscription" : "Cancelling a subscription");
    return { unavailable: true };
  }

  const { error, status } = await supabase.rpc("test_set_plan_renewal", {
    p_plan_id: params.planId,
    p_will_renew: params.willRenew,
  });

  if (error) {
    console.warn("Failed to change subscription renewal", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return {};
}

// Upgrades a running monthly subscription to yearly: the monthly one ends
// now and a yearly one starts in its place, whose id comes back. There's no
// way back to monthly.
export async function upgradeSubscription(params: {
  canTestPurchase: boolean;
  planId: string;
  source: PlanSource | null;
}): Promise<PurchaseResult & { planId?: string }> {
  if (!params.canTestPurchase || params.source !== "test") {
    showComingSoon("Upgrading to yearly");
    return { unavailable: true };
  }

  const { data, error, status } = await supabase.rpc("test_upgrade_subscription", {
    p_plan_id: params.planId,
  });

  if (error) {
    console.warn("Failed to upgrade subscription", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return { planId: (data as { id: string }).id };
}
