import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DayField, DayPicker, startOfDay } from "@/components/day-picker";
import { ModalHeader } from "@/components/modal-header";
import { type PlanMemberStatusTone, PlanMemberRow } from "@/components/plan-member-row";
import { PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import { type UpcomingPlan, useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { type MemberAccess, useGroupAccess } from "@/hooks/use-group-access";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import {
  formatAccessDate,
  formatPlanEnd,
  isCoveredAt,
  isNotStartedYet,
  isUnlockedAt,
  planEndsAt,
} from "@/utils/access";
import { DELETED_USER_ID } from "@/utils/balances";
import { goBackOrToGroups } from "@/utils/navigation";
import { reschedulePlan, setUpPlan } from "@/utils/plan-setup";

const DAY_MS = 86_400_000;
// set_up_plan/reschedule_plan refuse a start more than a year out.
const MAX_START_DAYS = 365;

// "1-week Trip Pass · up to 4 people"
function describePass(plan: UpcomingPlan) {
  const length = `${Math.round(plan.durationDays / 7)}-week Trip Pass`;
  return plan.seatCount > 1 ? `${length} · up to ${plan.seatCount} people` : `${length} · just you`;
}

// Where a group member stands against a pass that would run from
// `plannedStartsAt` until `plannedEndsAt`, for the seat picker. `covered`
// people don't need a seat, so they aren't picked by default.
function describeSeatNeed(
  member: MemberAccess | undefined,
  plannedStartsAt: number,
  plannedEndsAt: number
): { text: string; tone: PlanMemberStatusTone; covered: boolean } {
  if (!member || !isUnlockedAt(member.unlockedUntil)) {
    return { text: "Locked", tone: "muted", covered: false };
  }
  const until = formatAccessDate(member.unlockedUntil as number);
  if (member.willRenew) {
    return { text: "Has their own plan, which renews", tone: "success", covered: true };
  }
  // Over before the pass even starts: as good as locked for all of it.
  if (!isUnlockedAt(member.unlockedUntil, plannedStartsAt)) {
    return { text: `Unlocked until ${until}, before this pass starts`, tone: "muted", covered: false };
  }
  // Near its end, a countdown instead (dropping "before this pass ends",
  // which would read as if about the same pass).
  const countdown = formatPlanEnd(
    member.unlockedUntil as number,
    member.willRenew,
    member.unlockDays,
    ""
  );
  if ((member.unlockedUntil as number) >= plannedEndsAt) {
    return { text: countdown || `Already unlocked until ${until}`, tone: "success", covered: true };
  }
  return {
    text: countdown || `Unlocked until ${until}, before this pass ends`,
    tone: "warning",
    covered: false,
  };
}

type Step = "group" | "members" | "date";

// Setting up a bought Trip Pass, one step at a time: for a group size, which
// group it's for (for good — a set-up pass can't be moved), then when it
// starts, then who gets its first seats, judged on that start; for "Just
// me", only when it starts. Opened right after buying and from /plans
// for a pass set up later. For a pass that's already set up but hasn't
// started, only its start can be changed here. `groupId` preselects a group
// (the one the paywall was opened from).
export default function PlanSetupScreen() {
  const { planId, groupId: groupParam } = useLocalSearchParams<{
    planId: string;
    groupId?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const viewerId = session?.user.id ?? "";
  const { access, isLoaded, refresh: refreshAccess } = useAccess();
  const { groups } = useGroups();
  const { syncPending } = useLogs();
  const plan = access.upcomingPlans.find((item) => item.id === planId);
  const isSetUp = plan?.startsAt != null;
  const isGroupPass = (plan?.seatCount ?? 1) > 1;
  const steps: Step[] = isGroupPass && !isSetUp ? ["group", "date", "members"] : ["date"];
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const isLastStep = stepIndex >= steps.length - 1;

  // A group can only have one plan at a time, so groups that already have
  // one can't be picked; they're listed last, grayed out.
  const takenGroups = new Map(access.groupsWithPlans.map((item) => [item.groupId, item]));
  const openGroups = groups.filter((item) => !takenGroups.has(item.id));
  const closedGroups = groups.filter((item) => takenGroups.has(item.id));
  // The group it was bought from, or the only one there is to pick.
  const [chosenGroupId, setGroupId] = useState<string | null>(null);
  const defaultGroupId =
    groupParam && openGroups.some((item) => item.id === groupParam)
      ? groupParam
      : openGroups.length === 1
        ? openGroups[0].id
        : null;
  const groupId =
    chosenGroupId && !takenGroups.has(chosenGroupId) ? chosenGroupId : defaultGroupId;
  const group = groups.find((item) => item.id === groupId);
  // The group being picked, or for a pass already set up, its own (to see
  // whether a new start leaves its sponsor needing a seat).
  const accessGroupId = isGroupPass ? ((isSetUp ? plan?.groupId : groupId) ?? undefined) : undefined;
  const { access: groupAccess } = useGroupAccess(accessGroupId);
  const { members: allMembers } = useGroupMembers(accessGroupId);

  // "Now", as of opening the screen, for the calendar's range and the
  // dates shown — close enough for a day picker.
  const [openedAt] = useState(Date.now);
  const today = startOfDay(openedAt);
  const lastDay = startOfDay(openedAt + MAX_START_DAYS * DAY_MS);
  // Untouched, a pass being set up starts today and one being moved keeps
  // its own day. Today means right away rather than from midnight.
  const [chosenDay, setChosenDay] = useState<number | null>(null);
  const pickedDay =
    chosenDay ?? (plan?.startsAt != null ? Math.max(startOfDay(plan.startsAt), today) : today);
  const startsAt = pickedDay === today ? null : pickedDay;
  const plannedStart = startsAt ?? openedAt;
  const plannedEnd = planEndsAt(plannedStart, plan?.durationDays ?? 0);

  // The sponsor's own picks, or null until they change one — until then it's
  // just the sponsor's own seat (suggestedIds below), if they need one.
  const [pickedIds, setPickedIds] = useState<Record<string, boolean> | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seatCount = plan?.seatCount ?? 1;
  const groupHasPlan = !!groupAccess?.plan;
  // The sponsor first: they usually need a seat too.
  const candidates = allMembers
    .filter((member) => member.isActive && member.id !== DELETED_USER_ID)
    .sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId));
  const seatNeeds = Object.fromEntries(
    candidates.map((member) => [
      member.id,
      describeSeatNeed(groupAccess?.members[member.id], plannedStart, plannedEnd),
    ])
  );
  // Nobody else is ticked up front — the sponsor picks who gets a seat. Only
  // the sponsor is, when nothing else covers them for the whole pass.
  const suggestedIds = seatNeeds[viewerId] && !seatNeeds[viewerId].covered ? [viewerId] : [];
  // With nothing else unlocking them when it starts, the sponsor has to take
  // a seat on their own pass (set_up_plan refuses otherwise).
  const sponsorOwnAccess = groupAccess?.members[viewerId];
  const sponsorSeatRequired = !isCoveredAt(sponsorOwnAccess, plannedStart);
  const ownPicks: Record<string, boolean> =
    pickedIds ?? Object.fromEntries(suggestedIds.map((id) => [id, true]));
  const picked = {
    ...ownPicks,
    ...(sponsorSeatRequired ? { [viewerId]: true } : {}),
  };
  const pickedList = candidates.filter((member) => picked[member.id]).map((member) => member.id);
  const sponsorSkipWarning =
    !picked[viewerId] && seatNeeds[viewerId]?.tone === "warning"
      ? `Your own unlock ends ${formatAccessDate(sponsorOwnAccess?.unlockedUntil as number)}, before this pass does. Without a seat on it, you'll be locked from then on.`
      : null;

  const chooseGroup = (id: string) => {
    setGroupId(id);
    setPickedIds(null);
  };
  const togglePick = (id: string) => {
    if (id === viewerId && sponsorSeatRequired) return;
    if (!picked[id] && pickedList.length >= seatCount) return;
    // From ownPicks, not picked: a seat the start date forces on the sponsor
    // shouldn't stay picked once another date doesn't need it.
    setPickedIds({ ...ownPicks, [id]: !picked[id] });
  };

  // Seats are picked after the start, but going back and moving it can still
  // add the sponsor's required seat on top of a full pass. Then they have to
  // untick someone.
  const tooManySeats = isGroupPass && !isSetUp && pickedList.length > seatCount;
  // Moving a set-up pass is held to the same rule: the group's sponsor
  // (whoever took over if the buyer left), without a seat on it, needs
  // something else unlocking them on the new start (reschedule_plan refuses
  // otherwise), and gets the same warning when that ends before the pass does.
  const sponsor = allMembers.find((member) => member.isSponsor && member.isActive);
  const unseatedSponsor = isSetUp && sponsor ? groupAccess?.members[sponsor.id] : undefined;
  const sponsorStartUncovered =
    !!unseatedSponsor &&
    !unseatedSponsor.hasSeat &&
    !isCoveredAt(unseatedSponsor, plannedStart);
  const sponsorEndsEarly =
    !!unseatedSponsor &&
    !unseatedSponsor.hasSeat &&
    !sponsorStartUncovered &&
    describeSeatNeed(unseatedSponsor, plannedStart, plannedEnd).tone === "warning";
  const sponsorLabel = sponsor?.id === viewerId ? "you" : sponsor?.name;
  const rescheduleWarning = sponsorStartUncovered
    ? `Nothing else unlocks ${sponsorLabel} by then, and ${sponsor?.id === viewerId ? "you don't" : "they don't"} have a seat on this pass. Give ${sponsor?.id === viewerId ? "yourself" : "them"} one on the group plan first, or pick an earlier day.`
    : sponsorEndsEarly
      ? `${sponsor?.id === viewerId ? "Your" : `${sponsor?.name}'s`} own unlock ends ${formatAccessDate(unseatedSponsor?.unlockedUntil as number)}, before this pass does. Without a seat on it, ${sponsor?.id === viewerId ? "you'll" : "they'll"} be locked from then on.`
      : null;
  const groupReady = !!group && !!groupAccess && !groupHasPlan;
  const canSave =
    !!plan &&
    !isBusy &&
    !tooManySeats &&
    !sponsorStartUncovered &&
    (isSetUp || !isGroupPass || groupReady);
  const canContinue =
    step === "group"
      ? groupReady
      : step === "members"
        ? canSave && pickedList.length > 0
        : !isLastStep || canSave;

  const handleSave = async () => {
    if (!plan) return;
    setIsBusy(true);
    setError(null);
    const result = isSetUp
      ? await reschedulePlan({ planId: plan.id, startsAt })
      : await setUpPlan({
          planId: plan.id,
          groupId: isGroupPass ? (group?.id ?? null) : null,
          startsAt,
          memberIds: isGroupPass ? pickedList : [],
        });
    if (result.error) {
      setIsBusy(false);
      setError(result.error);
      return;
    }
    await refreshAccess();
    // A held entry may have been waiting for exactly this.
    if (startsAt === null) syncPending();
    setIsBusy(false);
    if (!isSetUp && isGroupPass && group) {
      router.replace({ pathname: "/group-plan", params: { groupId: group.id } });
    } else {
      goBackOrToGroups();
    }
  };

  const headerTitle = isSetUp ? "Change start date" : "Set up your pass";

  if (!plan) {
    return (
      <View style={styles.flex}>
        <ModalHeader title={headerTitle} onClose={goBackOrToGroups} />
        {isLoaded ? (
          <View style={styles.notFound}>
            <Text style={styles.muted}>This pass has already started, or couldn&apos;t be found.</Text>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <ModalHeader title={headerTitle} onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <View style={styles.passCard}>
          <Ionicons name="ticket-outline" size={22} color={Colors.accent} />
          <View style={styles.passText}>
            <Text style={styles.passTitle}>{describePass(plan)}</Text>
            <Text style={styles.passDetail}>
              {isSetUp
                ? `${plan.groupName ? `For ${plan.groupName}. ` : ""}Starts ${formatAccessDate(plan.startsAt as number)}. You can move it until then.`
                : isGroupPass
                  ? "It doesn't count down until it starts. Pick the group, when it starts and who gets a seat."
                  : "It unlocks you in every group, and doesn't count down until it starts."}
            </Text>
          </View>
        </View>

        {steps.length > 1 ? (
          <Text style={styles.stepLabel}>
            Step {stepIndex + 1} of {steps.length}
          </Text>
        ) : null}

        {step === "group" ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Which group</Text>
            {openGroups.length > 0 ? (
              <View style={styles.warningNote}>
                <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
                <Text style={styles.warningNoteText}>
                  Choose carefully: once it&apos;s set up, this pass stays with this group for good.
                  It can&apos;t be moved to another group later, and only this group&apos;s members
                  can get its seats.
                </Text>
              </View>
            ) : null}
            {groups.length === 0 ? (
              <Text style={styles.hint}>
                You&apos;re not in a group yet. Create or join one, then set this pass up from
                Your plans on the Account tab.
              </Text>
            ) : null}
            {openGroups.map((item) => {
              const isSelected = item.id === groupId;
              return (
                <Pressable
                  key={item.id}
                  style={[styles.row, isSelected && styles.rowSelected]}
                  onPress={() => chooseGroup(item.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Ionicons
                    name={isSelected ? "radio-button-on" : "radio-button-off"}
                    size={22}
                    color={isSelected ? Colors.accent : Colors.border}
                  />
                </Pressable>
              );
            })}
            {closedGroups.length > 0 ? (
              <>
                {closedGroups.map((item) => {
                  const taken = takenGroups.get(item.id);
                  return (
                    <View
                      key={item.id}
                      style={styles.row}
                      accessibilityRole="radio"
                      accessibilityState={{ disabled: true }}
                    >
                      {/* Only the contents are grayed out; the border stays
                          like every other row's. */}
                      <View style={[styles.rowText, styles.rowContentDisabled]}>
                        <Text style={[styles.rowLabel, styles.rowLabelDisabled]} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {taken ? (
                          <Text style={styles.rowDetail}>
                            {isNotStartedYet(taken.startsAt)
                              ? `Has a plan starting ${formatAccessDate(taken.startsAt)}`
                              : `Has a plan until ${formatAccessDate(taken.endsAt)}`}
                          </Text>
                        ) : null}
                      </View>
                      <Ionicons
                        name="lock-closed-outline"
                        size={20}
                        color={Colors.muted}
                        style={styles.rowContentDisabled}
                      />
                    </View>
                  );
                })}
                <Text style={styles.hint}>
                  A group can only have one plan at a time, so{" "}
                  {closedGroups.length === 1 ? "this one is" : "these are"} taken until{" "}
                  {closedGroups.length === 1 ? "its plan ends" : "their plans end"}. Anyone in{" "}
                  {closedGroups.length === 1 ? "it" : "them"} without a seat can ask its sponsor
                  for one.
                </Text>
              </>
            ) : null}
          </View>
        ) : null}

        {step === "date" ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>When it starts</Text>
            <DayField value={pickedDay} min={today} max={lastDay} onChange={setChosenDay} />
            <DayPicker value={pickedDay} min={today} max={lastDay} onChange={setChosenDay} />
            <Text style={styles.hint}>
              {startsAt === null
                ? `Starts now and runs until ${formatAccessDate(plannedEnd)}.`
                : `Runs from ${formatAccessDate(plannedStart)} (midnight) until ${formatAccessDate(plannedEnd)}.`}
            </Text>
            {isGroupPass && !isSetUp && sponsorSeatRequired ? (
              <Text style={styles.hint}>
                Nothing else unlocks you by then, so one of its seats will be yours.
              </Text>
            ) : null}
            {rescheduleWarning ? (
              <View style={styles.warningNote}>
                <Ionicons name="time-outline" size={16} color={Colors.warning} />
                <Text style={styles.warningNoteText}>{rescheduleWarning}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {step === "members" && group && groupAccess && !groupHasPlan ? (
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
            {tooManySeats ? (
              <View style={styles.warningNote}>
                <Ionicons name="time-outline" size={16} color={Colors.warning} />
                <Text style={styles.warningNoteText}>
                  Nothing else unlocks you by then, so you need a seat yourself. Untick someone to
                  free one for you.
                </Text>
              </View>
            ) : null}
            {sponsorSkipWarning ? (
              <View style={styles.warningNote}>
                <Ionicons name="time-outline" size={16} color={Colors.warning} />
                <Text style={styles.warningNoteText}>{sponsorSkipWarning}</Text>
              </View>
            ) : null}
            <Text style={styles.hint}>
              You can change who has a seat until the pass starts. After that, a seat stays with
              its holder for the whole duration of the pass.
            </Text>
            <View style={styles.warningNote}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
              <Text style={styles.warningNoteText}>
                This pass will be for {group.name} for good. It can&apos;t be moved to another group
                later.
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {/* Disabled dimming lives on a wrapper — PressableScale animates the
            button's own opacity, which would override it. */}
        <View style={!canContinue && styles.buttonDisabled}>
          <PressableScale
            style={styles.button}
            pressedScale={0.98}
            onPress={isLastStep ? handleSave : () => setStepIndex(stepIndex + 1)}
            disabled={!canContinue}
          >
            <Text style={styles.buttonText}>
              {!isLastStep
                ? "Next"
                : isBusy
                  ? "Saving..."
                  : isSetUp
                    ? "Save start date"
                    : "Set up pass"}
            </Text>
          </PressableScale>
        </View>
        {stepIndex > 0 ? (
          <Pressable
            onPress={() => setStepIndex(stepIndex - 1)}
            hitSlop={8}
            style={styles.laterButton}
          >
            <Text style={styles.laterText}>Back</Text>
          </Pressable>
        ) : !isSetUp ? (
          <Pressable onPress={goBackOrToGroups} hitSlop={8} style={styles.laterButton}>
            <Text style={styles.laterText}>Set up later</Text>
          </Pressable>
        ) : null}
      </View>
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
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  muted: {
    fontSize: 15,
    color: Colors.muted,
    textAlign: "center",
  },
  passCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 16,
    borderRadius: 12,
    backgroundColor: Colors.eventSurface,
    borderWidth: 1,
    borderColor: Colors.eventBorder,
  },
  passText: {
    flex: 1,
    gap: 4,
  },
  passTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  passDetail: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.muted,
  },
  section: {
    gap: 10,
  },
  stepLabel: {
    marginBottom: -8,
    fontSize: 13,
    fontWeight: "500",
    color: Colors.muted,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    color: Colors.muted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rowSelected: {
    borderColor: Colors.accent,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  rowContentDisabled: {
    opacity: 0.6,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabelDisabled: {
    flex: 0,
    color: Colors.muted,
  },
  rowDetail: {
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
  footer: {
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  error: {
    fontSize: 14,
    color: Colors.danger,
    textAlign: "center",
  },
  button: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
  laterButton: {
    alignSelf: "center",
    paddingVertical: 4,
  },
  laterText: {
    fontSize: 15,
    fontWeight: "500",
    color: Colors.accent,
  },
});
