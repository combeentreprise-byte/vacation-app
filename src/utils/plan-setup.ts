import { supabase } from "@/lib/supabase";
import { requestErrorMessage } from "@/utils/network";

// Setting up a bought Trip Pass and moving its start (set_up_plan and
// reschedule_plan in schema.sql, which enforce every rule). Online-only, like
// buying. A null start means right away.

export async function setUpPlan(params: {
  planId: string;
  // Null for "Just me".
  groupId: string | null;
  startsAt: number | null;
  memberIds: string[];
}): Promise<{ error?: string }> {
  const { error, status } = await supabase.rpc("set_up_plan", {
    p_plan_id: params.planId,
    p_group_id: params.groupId,
    p_starts_at: params.startsAt === null ? null : new Date(params.startsAt).toISOString(),
    p_member_ids: params.memberIds,
  });
  if (error) {
    console.warn("Failed to set up plan", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return {};
}

export async function reschedulePlan(params: {
  planId: string;
  startsAt: number | null;
}): Promise<{ error?: string }> {
  const { error, status } = await supabase.rpc("reschedule_plan", {
    p_plan_id: params.planId,
    p_starts_at: params.startsAt === null ? null : new Date(params.startsAt).toISOString(),
  });
  if (error) {
    console.warn("Failed to change plan start", error);
    return { error: requestErrorMessage(error.message, status) };
  }
  return {};
}
