import { router } from "expo-router";
import { useCallback } from "react";

import { useAccess } from "@/hooks/use-access";

// Opens what an "Unlock" inside a group should lead to. Someone who already
// bought a Trip Pass and hasn't set it up yet goes to /plans to set that one
// up rather than being offered another one on /paywall — with the group
// passed on, so setting up preselects it.
export function useOpenUnlock() {
  const { access } = useAccess();
  const hasPassToSetUp = access.upcomingPlans.some((plan) => plan.startsAt === null);

  return useCallback(
    (params: { groupId: string; justMe?: boolean }) => {
      if (hasPassToSetUp) {
        router.push({ pathname: "/plans", params: { groupId: params.groupId } });
        return;
      }
      router.push({
        pathname: "/paywall",
        params: params.justMe ? { groupId: params.groupId, justMe: "1" } : { groupId: params.groupId },
      });
    },
    [hasPassToSetUp]
  );
}
