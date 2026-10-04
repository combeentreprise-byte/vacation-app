import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { EXPAND_ANIMATION, Expandable } from "@/components/expandable";
import { ModalHeader } from "@/components/modal-header";
import { PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import { type ActivePlan, type PastPlan, type UpcomingPlan, useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { useGroups } from "@/hooks/use-groups";
import { formatAccessDate, formatPlanEnd } from "@/utils/access";
import { goBackOrToGroups } from "@/utils/navigation";

// Every plan the viewer sponsors or holds a seat on — Trip Passes still to
// set up, ones set up to start later, running ones, subscriptions, and
// (folded away) ended ones — opened from the Account tab's plan card (which
// goes straight to the paywall when there are none). Buying another one opens
// the paywall's pricing page.
function describePlan(plan: ActivePlan, viewerId: string) {
  const isSponsor = plan.sponsorId === viewerId;
  const type = plan.kind === "trip_pass" ? "Trip Pass" : "Subscription";
  const from = isSponsor
    ? plan.hasSeat
      ? "Yours"
      : "Yours · you don't hold a seat"
    : `From ${plan.sponsorName ?? "a deleted account"}`;
  const when = formatPlanEnd(
    plan.endsAt,
    plan.willRenew,
    plan.durationDays,
    `${plan.willRenew ? "Renews" : "Until"} ${formatAccessDate(plan.endsAt)}`
  );
  const isGroupPlan = plan.seatCount > 1;
  return {
    title: plan.groupId === null && !isGroupPlan ? "Just me" : (plan.groupName ?? "Deleted group"),
    detail: `${type} · ${from}`,
    meta: isGroupPlan ? `${when} · ${plan.seatsUsed} of ${plan.seatCount} seats used` : when,
  };
}

// A Trip Pass that hasn't started: bought but not set up, or starting later.
function describeUpcoming(plan: UpcomingPlan, viewerId: string) {
  const length = `${Math.round(plan.durationDays / 7)}-week Trip Pass`;
  const size = plan.seatCount > 1 ? `up to ${plan.seatCount} people` : "just you";
  if (plan.startsAt === null || plan.endsAt === null) {
    return {
      title: `${length} · ${size}`,
      detail: "Ready when you are · Set it up now",
      meta: plan.seatCount > 1 ? "Pick your group and start day" : "Pick your start day",
    };
  }
  const from =
    plan.sponsorId === viewerId ? "Yours" : `From ${plan.sponsorName ?? "a deleted account"}`;
  return {
    title: plan.seatCount > 1 ? (plan.groupName ?? "Deleted group") : "Just me",
    detail: `${length} · ${from}`,
    meta: `Starts ${formatAccessDate(plan.startsAt)} · until ${formatAccessDate(plan.endsAt)}${
      plan.seatCount > 1 ? ` · ${plan.seatsUsed} of ${plan.seatCount} seats used` : ""
    }`,
  };
}

// An ended plan, in the "Former plans" list.
function describePast(plan: PastPlan, viewerId: string) {
  const type =
    plan.kind === "trip_pass"
      ? `${Math.round(plan.durationDays / 7)}-week Trip Pass`
      : plan.durationDays <= 31
        ? "Monthly subscription"
        : "Yearly subscription";
  const from =
    plan.sponsorId === viewerId ? "Yours" : `From ${plan.sponsorName ?? "a deleted account"}`;
  return {
    title: plan.seatCount > 1 ? (plan.groupName ?? "Deleted group") : "Just me",
    detail: `${type} · ${from}`,
    meta: `${formatAccessDate(plan.startsAt)} – ${formatAccessDate(plan.endsAt)}`,
  };
}

function PlanRow({
  title,
  detail,
  meta,
  icon,
  onPress,
}: {
  title: string;
  detail: string;
  meta: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: (() => void) | null;
}) {
  const body = (
    <>
      <View style={styles.planIcon}>
        <Ionicons name={icon} size={20} color={Colors.accent} />
      </View>
      <View style={styles.planText}>
        <Text style={styles.planTitle}>{title}</Text>
        <Text style={styles.planDetail}>{detail}</Text>
        <Text style={styles.planMeta}>{meta}</Text>
      </View>
    </>
  );
  return onPress ? (
    <Pressable style={styles.plan} onPress={onPress} accessibilityRole="button">
      {body}
      <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
    </Pressable>
  ) : (
    <View style={styles.plan}>{body}</View>
  );
}

// The former-plans toggle's chevron, turning over in step with the list
// opening and closing below it.
function RotatingChevron({ open }: { open: boolean }) {
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.set(withTiming(open ? 1 : 0, EXPAND_ANIMATION));
  }, [open, turn]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.value * 180}deg` }],
  }));
  return (
    <Animated.View style={style}>
      <Ionicons name="chevron-down" size={16} color={Colors.text} />
    </Animated.View>
  );
}

// `groupId`: the group an "Unlock" sent the viewer here from, passed on to
// /plan-setup so setting up a pass preselects it.
export default function PlansScreen() {
  const { groupId: groupParam } = useLocalSearchParams<{ groupId?: string }>();
  const { session } = useAuth();
  const viewerId = session?.user.id ?? "";
  const { groups } = useGroups();
  const { access, refresh } = useAccess();
  // Former plans stay tucked away until asked for.
  const [showPast, setShowPast] = useState(false);
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // Trip Passes are split by whether they've started; subscriptions get their
  // own section. "Not started yet" is always titled, the others only once
  // there's more than one section.
  const runningPasses = access.activePlans.filter((plan) => plan.kind === "trip_pass");
  const subscriptions = access.activePlans.filter((plan) => plan.kind === "subscription");
  const showSectionTitles =
    [access.upcomingPlans, runningPasses, subscriptions].filter((list) => list.length > 0)
      .length > 1;

  const renderActivePlan = (plan: ActivePlan) => {
    const { title, detail, meta } = describePlan(plan, viewerId);
    // A subscription opens its own billing details. A group plan's seats are
    // managed on the group's plan screen, which only the group's active
    // members can open.
    const groupId = plan.groupId;
    const onPress =
      plan.kind === "subscription"
        ? () => router.push({ pathname: "/subscription", params: { planId: plan.id } })
        : groupId && groups.some((group) => group.id === groupId)
          ? () => router.push({ pathname: "/group-plan", params: { groupId } })
          : null;
    return (
      <PlanRow
        key={plan.id}
        title={title}
        detail={detail}
        meta={meta}
        icon={groupId ? "people-outline" : plan.kind === "subscription" ? "repeat" : "person-outline"}
        onPress={onPress}
      />
    );
  };

  return (
    <View style={styles.flex}>
      <ModalHeader title="Your plans" onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {access.activePlans.length === 0 && access.upcomingPlans.length === 0 ? (
          <Text style={styles.empty}>You don&apos;t have any plans yet.</Text>
        ) : null}

        {access.upcomingPlans.length > 0 ? (
          <Text style={styles.sectionTitle}>Not started yet</Text>
        ) : null}
        {access.upcomingPlans.map((plan) => {
          const { title, detail, meta } = describeUpcoming(plan, viewerId);
          const groupId = plan.groupId;
          const isMember = !!groupId && groups.some((group) => group.id === groupId);
          // Not set up, or your own "Just me": set it up / move its start.
          // A group pass: its plan screen, where its manager can move it too.
          const onPress =
            plan.sponsorId === viewerId && (plan.startsAt === null || plan.seatCount === 1)
              ? () =>
                  router.push({
                    pathname: "/plan-setup",
                    params: groupParam ? { planId: plan.id, groupId: groupParam } : { planId: plan.id },
                  })
              : isMember
                ? () => router.push({ pathname: "/group-plan", params: { groupId } })
                : null;
          return (
            <PlanRow
              key={plan.id}
              title={title}
              detail={detail}
              meta={meta}
              icon={plan.startsAt === null ? "ticket-outline" : "calendar-outline"}
              onPress={onPress}
            />
          );
        })}

        {runningPasses.length > 0 && showSectionTitles ? (
          <Text style={styles.sectionTitle}>Running</Text>
        ) : null}
        {runningPasses.map(renderActivePlan)}

        {subscriptions.length > 0 && showSectionTitles ? (
          <Text style={styles.sectionTitle}>Subscriptions</Text>
        ) : null}
        {subscriptions.map(renderActivePlan)}

        {/* One block with the list, so the list's own spacing grows and
            shrinks with it instead of snapping in around it. */}
        {access.pastPlans.length > 0 ? (
          <View>
            <Pressable
              style={styles.pastToggle}
              onPress={() => setShowPast((current) => !current)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showPast }}
            >
              <Text style={styles.pastToggleText}>
                {showPast ? "Hide former plans" : `Show former plans (${access.pastPlans.length})`}
              </Text>
              <RotatingChevron open={showPast} />
            </Pressable>
            <Expandable open={showPast}>
              <View style={styles.pastList}>
                {access.pastPlans.map((plan) => {
                  const { title, detail, meta } = describePast(plan, viewerId);
                  return (
                    <View key={plan.id} style={styles.pastPlan}>
                      <PlanRow
                        title={title}
                        detail={detail}
                        meta={meta}
                        icon="time-outline"
                        onPress={null}
                      />
                    </View>
                  );
                })}
              </View>
            </Expandable>
          </View>
        ) : null}

        <PressableScale
          style={styles.buyButton}
          pressedScale={0.98}
          onPress={() => router.push({ pathname: "/paywall", params: { pricingOnly: "1" } })}
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
  sectionTitle: {
    marginTop: 4,
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
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
  pastToggle: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginTop: 4,
    paddingVertical: 4,
  },
  // Looks like the section titles (without their top margin, which would
  // knock it off-center from the chevron).
  pastToggleText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  pastList: {
    gap: 12,
    paddingTop: 12,
  },
  pastPlan: {
    opacity: 0.6,
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
