import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ModalHeader } from "@/components/modal-header";
import { type PlanMemberStatusTone, PlanMemberRow } from "@/components/plan-member-row";
import { PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import {
  formatPrice,
  GROUP_PLAN_SIZES,
  groupPlanTitle,
  JUST_ME_SEATS,
  PLAN_PERIODS,
  planKindLabel,
  type PlanPeriod,
  planPrice,
} from "@/constants/plans";
import { type MyAccess, useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { type MemberAccess, useGroupAccess } from "@/hooks/use-group-access";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import { endsAtIfBoughtNow, formatAccessDate, isUnlockedAt } from "@/utils/access";
import { goBackOrToGroups } from "@/utils/navigation";
import { purchasePlan } from "@/utils/purchases";

// Where the viewer stands right now, shown at the top.
function describeOwnAccess(access: MyAccess, viewerId: string) {
  const plan = access.coveringPlan;
  if (plan) {
    const whose = plan.sponsorId === viewerId ? "Your" : `${plan.sponsorName ?? "Someone"}'s`;
    return {
      title: plan.willRenew
        ? `Unlocked · renews ${formatAccessDate(plan.endsAt)}`
        : `Unlocked until ${formatAccessDate(plan.endsAt)}`,
      detail: `${whose} ${planKindLabel(plan.kind)}.`,
    };
  }
  return {
    title: "You're locked",
    detail: `Everyone gets ${access.freeEntriesPerUser} free entries in each group. Once yours are used up, adding or editing one needs everyone on it to be unlocked. Viewing, settling up and deleting your own entries are always free.`,
  };
}

// Where a group member stands against a plan that would run until
// `plannedEndsAt`, for the seat picker. `covered` people don't need a seat,
// so they aren't picked by default.
function describeSeatNeed(
  member: MemberAccess | undefined,
  plannedEndsAt: number
): { text: string; tone: PlanMemberStatusTone; covered: boolean } {
  if (!member || !isUnlockedAt(member.unlockedUntil)) {
    return { text: "Locked", tone: "muted", covered: false };
  }
  const until = formatAccessDate(member.unlockedUntil as number);
  if (member.willRenew) {
    return { text: "Has their own plan, which renews", tone: "success", covered: true };
  }
  if ((member.unlockedUntil as number) >= plannedEndsAt) {
    return { text: `Already unlocked until ${until}`, tone: "success", covered: true };
  }
  return { text: `Unlocked until ${until}, before this plan ends`, tone: "warning", covered: false };
}

function OptionRow({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.option, selected && styles.optionSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        <Text style={styles.optionDescription}>{description}</Text>
      </View>
      <Ionicons
        name={selected ? "radio-button-on" : "radio-button-off"}
        size={22}
        color={selected ? Colors.accent : Colors.border}
      />
    </Pressable>
  );
}

export default function UnlockScreen() {
  // Set when opened from a group (its + button, the entry form, its plan
  // screen), which lets that group be unlocked as a whole too.
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const { session } = useAuth();
  const viewerId = session?.user.id ?? "";
  const { groups } = useGroups();
  const group = groupId ? groups.find((item) => item.id === groupId) : undefined;
  const { access, refresh: refreshAccess } = useAccess();
  const { access: groupAccess, refresh: refreshGroupAccess } = useGroupAccess(group?.id);
  const { members: allMembers } = useGroupMembers(group?.id);
  const { syncPending } = useLogs();
  // Someone may have handed you a seat since the app last asked.
  useFocusEffect(
    useCallback(() => {
      refreshAccess();
    }, [refreshAccess])
  );
  // Group plans only: a "Just me" one already shows as your own status above.
  const sponsoredGroupPlans = access.activePlans.filter(
    (plan) => plan.sponsorId === viewerId && plan.groupId !== null
  );

  const runningPlan = groupAccess?.plan ?? null;
  // One sponsor per group: its sizes are only on offer while it has no
  // running plan (create_plan refuses a second one either way).
  const canBuyForGroup = !!group && !runningPlan;
  const [chosenSeatCount, setChosenSeatCount] = useState<number>(JUST_ME_SEATS);
  const seatCount = canBuyForGroup ? chosenSeatCount : JUST_ME_SEATS;
  const isGroupSize = seatCount > JUST_ME_SEATS;
  const [period, setPeriod] = useState<PlanPeriod>("week");
  const periodInfo = PLAN_PERIODS.find((item) => item.key === period) ?? PLAN_PERIODS[0];
  // The sponsor's own picks, or null until they change one — until then the
  // suggestion below follows whatever size/length is chosen.
  const [pickedIds, setPickedIds] = useState<Record<string, boolean> | null>(null);
  const [isBuying, setIsBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plannedEndsAt = endsAtIfBoughtNow(periodInfo.days);
  // The sponsor first: they usually need a seat too.
  const candidates = allMembers
    .filter((member) => member.isActive)
    .sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId));
  const seatNeeds = Object.fromEntries(
    candidates.map((member) => [
      member.id,
      describeSeatNeed(groupAccess?.members[member.id], plannedEndsAt),
    ])
  );
  const suggestedIds = candidates
    .filter((member) => !seatNeeds[member.id].covered)
    .slice(0, seatCount)
    .map((member) => member.id);
  // With nothing else unlocking them, the sponsor has to take a seat on their
  // own plan (create_plan refuses otherwise), so theirs is always picked.
  // Already unlocked, they may skip it, even if that unlock ends first.
  const sponsorOwnAccess = groupAccess?.members[viewerId];
  const sponsorSeatRequired = !isUnlockedAt(sponsorOwnAccess?.unlockedUntil);
  const picked = {
    ...(pickedIds ?? Object.fromEntries(suggestedIds.map((id) => [id, true]))),
    ...(sponsorSeatRequired ? { [viewerId]: true } : {}),
  };
  const pickedList = candidates.filter((member) => picked[member.id]).map((member) => member.id);

  const chooseSeatCount = (count: number) => {
    setChosenSeatCount(count);
    setPickedIds(null);
  };
  const choosePeriod = (key: PlanPeriod) => {
    setPeriod(key);
    setPickedIds(null);
  };
  const togglePick = (id: string) => {
    if (id === viewerId && sponsorSeatRequired) return;
    if (!picked[id] && pickedList.length >= seatCount) return;
    setPickedIds({ ...picked, [id]: !picked[id] });
  };

  const own = describeOwnAccess(access, viewerId);
  // Skipping your own seat while your other unlock runs out first is
  // allowed, but worth saying.
  const sponsorSkipWarning =
    isGroupSize && !picked[viewerId] && seatNeeds[viewerId]?.tone === "warning"
      ? `Your own unlock ends ${formatAccessDate(sponsorOwnAccess?.unlockedUntil as number)}, before this plan does. Without a seat on it, you'll be locked from then on.`
      : null;
  // Only needed when someone else manages the plan (the viewer would
  // otherwise be its manager): its sponsor, or its admins once they've left.
  const sponsor = allMembers.find((member) => member.id === runningPlan?.sponsorId);
  const askForSeat =
    group && sponsor?.isActive
      ? `${sponsor.name} sponsors ${group.name}. Ask them for a seat, or unlock just yourself here.`
      : `${group?.name}'s sponsor has left, so its admins hand out the seats. Ask one of them, or unlock just yourself here.`;
  const whenItEnds =
    periodInfo.kind === "trip_pass"
      ? `Ends ${formatAccessDate(plannedEndsAt)}.`
      : `Renews every ${period === "year" ? "year" : "month"} until cancelled.`;
  const summary = isGroupSize
    ? `${periodInfo.kind === "trip_pass" ? "Trip Pass" : "Plan"} for up to ${seatCount} people in ${group?.name}. ${whenItEnds}`
    : `${periodInfo.kind === "trip_pass" ? "Trip Pass" : "Plan"} for you, in every group. ${whenItEnds}`;

  const handleBuy = async () => {
    setError(null);
    setIsBuying(true);
    const result = await purchasePlan({
      canTestPurchase: access.canTestPurchase,
      groupId: isGroupSize && group ? group.id : null,
      period,
      seatCount,
      memberIds: isGroupSize ? pickedList : [],
    });
    if (result.error || result.unavailable) {
      setIsBuying(false);
      if (result.error) setError(result.error);
      return;
    }
    await Promise.all([refreshAccess(), refreshGroupAccess()]);
    // A held entry may have been waiting for exactly this.
    syncPending();
    setIsBuying(false);
    goBackOrToGroups();
  };

  return (
    <View style={styles.flex}>
      <ModalHeader title="Unlock entries" onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <View style={styles.statusCard}>
          <Ionicons
            name={access.coveringPlan ? "lock-open-outline" : "lock-closed-outline"}
            size={22}
            color={access.coveringPlan ? Colors.success : Colors.muted}
          />
          <View style={styles.statusText}>
            <Text style={styles.statusTitle}>{own.title}</Text>
            <Text style={styles.statusDetail}>{own.detail}</Text>
            {!access.paywallEnabled ? (
              <Text style={styles.statusDetail}>
                The paywall is still switched off, so everyone can add entries for now.
              </Text>
            ) : null}
          </View>
        </View>

        {sponsoredGroupPlans.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Plans you sponsor</Text>
            {sponsoredGroupPlans.map((plan) => (
              <Pressable
                key={plan.id}
                style={styles.option}
                onPress={() =>
                  plan.groupId &&
                  router.push({ pathname: "/group-plan", params: { groupId: plan.groupId } })
                }
                accessibilityRole="button"
              >
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>{plan.groupName ?? "A group"}</Text>
                  <Text style={styles.optionDescription}>
                    {groupPlanTitle(plan.kind)} · {plan.seatsUsed} of {plan.seatCount} seats ·{" "}
                    {plan.willRenew ? "renews" : "until"} {formatAccessDate(plan.endsAt)}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
              </Pressable>
            ))}
          </View>
        ) : null}

        {group && runningPlan ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>
              {runningPlan.canManage
                ? `You hand out ${group.name}'s seats — do that from its group plan.`
                : askForSeat}
            </Text>
            {runningPlan.canManage ? (
              <Pressable
                onPress={() =>
                  router.replace({ pathname: "/group-plan", params: { groupId: group.id } })
                }
                hitSlop={8}
              >
                <Text style={styles.noteLink}>Open group plan</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Who it&apos;s for</Text>
          <OptionRow
            label="Just me"
            description={`Unlocks you in every group · ${formatPrice(planPrice(period, JUST_ME_SEATS))}`}
            selected={seatCount === JUST_ME_SEATS}
            onPress={() => chooseSeatCount(JUST_ME_SEATS)}
          />
          {canBuyForGroup
            ? GROUP_PLAN_SIZES.map((size) => (
                <OptionRow
                  key={size}
                  label={`Up to ${size} people`}
                  description={`You pick who in ${group?.name} gets a seat · ${formatPrice(planPrice(period, size))}`}
                  selected={seatCount === size}
                  onPress={() => chooseSeatCount(size)}
                />
              ))
            : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How long</Text>
          {PLAN_PERIODS.map((item) => (
            <OptionRow
              key={item.key}
              label={item.label}
              description={`${item.kind === "trip_pass" ? "Trip Pass, pay once" : "Renews until cancelled"} · ${formatPrice(planPrice(item.key, seatCount))}${item.key === "month" ? " / month" : item.key === "year" ? " / year" : ""}`}
              selected={period === item.key}
              onPress={() => choosePeriod(item.key)}
            />
          ))}
        </View>

        {isGroupSize ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Who gets a seat · {pickedList.length} of {seatCount}
            </Text>
            {candidates.map((member) => {
              const need = seatNeeds[member.id];
              const isPicked = !!picked[member.id];
              const isRequired = member.id === viewerId && sponsorSeatRequired;
              return (
                <PlanMemberRow
                  key={member.id}
                  name={member.name}
                  label={member.id === viewerId ? "You" : member.name}
                  avatarUrl={member.avatarUrl}
                  status={isRequired ? "Needs a seat, since nothing else unlocks you" : need.text}
                  statusTone={need.tone}
                  onPress={() => togglePick(member.id)}
                  disabled={isRequired || (!isPicked && pickedList.length >= seatCount)}
                  accessory={
                    <Ionicons
                      name={isPicked ? "checkbox" : "square-outline"}
                      size={24}
                      color={isPicked ? Colors.accent : Colors.muted}
                    />
                  }
                />
              );
            })}
            {sponsorSkipWarning ? (
              <View style={styles.warningNote}>
                <Ionicons name="time-outline" size={16} color={Colors.warning} />
                <Text style={styles.warningNoteText}>{sponsorSkipWarning}</Text>
              </View>
            ) : null}
            <Text style={styles.hint}>
              Seats can also be handed out later, e.g. to someone who joins late.
            </Text>
          </View>
        ) : null}

        <Text style={styles.summary}>{summary}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Disabled dimming lives on a wrapper — PressableScale animates the
            button's own opacity, which would override it. */}
        <View style={isBuying && styles.buyButtonDisabled}>
          <PressableScale
            style={styles.buyButton}
            pressedScale={0.98}
            onPress={handleBuy}
            disabled={isBuying}
          >
            <Text style={styles.buyButtonText}>
              {isBuying
                ? "Unlocking..."
                : `Unlock · ${formatPrice(planPrice(period, seatCount))}${access.canTestPurchase ? " (free test purchase)" : ""}`}
            </Text>
          </PressableScale>
        </View>
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
    gap: 20,
  },
  statusCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statusText: {
    flex: 1,
    gap: 4,
  },
  statusTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  statusDetail: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.muted,
  },
  note: {
    gap: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Colors.eventSurface,
    borderWidth: 1,
    borderColor: Colors.eventBorder,
  },
  noteText: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.eventText,
  },
  noteLink: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.accent,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  optionSelected: {
    borderColor: Colors.accent,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  optionDescription: {
    fontSize: 13,
    color: Colors.muted,
  },
  hint: {
    fontSize: 13,
    color: Colors.muted,
  },
  warningNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  warningNoteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.warning,
  },
  summary: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.text,
  },
  error: {
    fontSize: 14,
    color: Colors.danger,
  },
  buyButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buyButtonDisabled: {
    opacity: 0.5,
  },
  buyButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
});
