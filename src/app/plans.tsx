import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ModalHeader } from "@/components/modal-header";
import { PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import { type ActivePlan, useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { useGroups } from "@/hooks/use-groups";
import { formatAccessDate } from "@/utils/access";
import { goBackOrToGroups } from "@/utils/navigation";

// Every running plan the viewer sponsors or holds a seat on, opened from the
// Account tab's plan card (which goes straight to /unlock when there are
// none). Buying another one is still /unlock.
function describePlan(plan: ActivePlan, viewerId: string) {
  const isSponsor = plan.sponsorId === viewerId;
  const type = plan.kind === "trip_pass" ? "Trip Pass" : "Subscription";
  const from = isSponsor
    ? plan.hasSeat
      ? "Yours"
      : "Yours · you don't hold a seat"
    : `From ${plan.sponsorName ?? "a deleted account"}`;
  const when = `${plan.willRenew ? "Renews" : "Until"} ${formatAccessDate(plan.endsAt)}`;
  const isGroupPlan = plan.seatCount > 1;
  return {
    title: plan.groupId === null && !isGroupPlan ? "Just me" : (plan.groupName ?? "Deleted group"),
    detail: `${type} · ${from}`,
    meta: isGroupPlan ? `${when} · ${plan.seatsUsed} of ${plan.seatCount} seats used` : when,
  };
}

export default function PlansScreen() {
  const { session } = useAuth();
  const viewerId = session?.user.id ?? "";
  const { groups } = useGroups();
  const { access, refresh } = useAccess();
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  return (
    <View style={styles.flex}>
      <ModalHeader title="Your plans" onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {access.activePlans.length === 0 ? (
          <Text style={styles.empty}>You don&apos;t have any running plans.</Text>
        ) : null}

        {access.activePlans.map((plan) => {
          const { title, detail, meta } = describePlan(plan, viewerId);
          // Its seats are managed on the group's plan screen, which only
          // the group's active members can open.
          const groupId = plan.groupId;
          const canOpen = !!groupId && groups.some((group) => group.id === groupId);
          const body = (
            <>
              <View style={styles.planIcon}>
                <Ionicons
                  name={groupId ? "people-outline" : "person-outline"}
                  size={20}
                  color={Colors.accent}
                />
              </View>
              <View style={styles.planText}>
                <Text style={styles.planTitle}>{title}</Text>
                <Text style={styles.planDetail}>{detail}</Text>
                <Text style={styles.planMeta}>{meta}</Text>
              </View>
            </>
          );
          return canOpen ? (
            <Pressable
              key={plan.id}
              style={styles.plan}
              onPress={() => router.push({ pathname: "/group-plan", params: { groupId } })}
              accessibilityRole="button"
            >
              {body}
              <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
            </Pressable>
          ) : (
            <View key={plan.id} style={styles.plan}>
              {body}
            </View>
          );
        })}

        <PressableScale
          style={styles.buyButton}
          pressedScale={0.98}
          onPress={() => router.push("/unlock")}
        >
          <Text style={styles.buyButtonText}>Get another plan</Text>
        </PressableScale>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 12,
  },
  empty: {
    fontSize: 15,
    color: Colors.muted,
  },
  plan: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  planIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.eventSurface,
    alignItems: "center",
    justifyContent: "center",
  },
  planText: {
    flex: 1,
    gap: 2,
  },
  planTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  planDetail: {
    fontSize: 13,
    color: Colors.text,
  },
  planMeta: {
    fontSize: 13,
    color: Colors.muted,
  },
  buyButton: {
    marginTop: 8,
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buyButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
});
