import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { EXPAND_DURATION_MS, Expandable } from "@/components/expandable";
import { ConfirmationBody } from "@/components/leave-group-confirmation";
import { ModalHeader } from "@/components/modal-header";
import { type PlanMemberStatusTone, PlanMemberRow } from "@/components/plan-member-row";
import { PlanUpgradeCard } from "@/components/plan-upgrade-card";
import { PressableScale } from "@/components/press-feedback";
import { PlanRowSkeleton } from "@/components/screen-skeletons";
import { SkeletonGroup, SkeletonText } from "@/components/skeleton";
import { Colors } from "@/constants/colors";
import { groupPlanTitle, type PlanPeriod } from "@/constants/plans";
import { useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { type GroupPlan, type MemberAccess, useGroupAccess } from "@/hooks/use-group-access";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import { useOpenUnlock } from "@/hooks/use-open-unlock";
import { useRefreshOnRefocus } from "@/hooks/use-refresh-on-refocus";
import {
  entriesNeedUnlock,
  formatAccessDate,
  formatPlanEnd,
  freeEntriesLeft,
  isCoveredAt,
  isMemberUnlocked,
  isNotStartedYet,
  isUnlockedAt,
  unlockEndsEarly,
} from "@/utils/access";
import { DELETED_USER_ID } from "@/utils/balances";
import { goBackOrToGroups } from "@/utils/navigation";
import { upgradePlan } from "@/utils/purchases";

// Where one member stands against the group's plan.
function describeMember(
  member: MemberAccess | undefined,
  isActive: boolean,
  plan: GroupPlan | null
): { text: string; tone: PlanMemberStatusTone } {
  if (member?.hasSeat) {
    // A seat on a pass that hasn't started doesn't unlock anyone yet.
    const from =
      plan && isNotStartedYet(plan.startsAt) ? ` from ${formatAccessDate(plan.startsAt as number)}` : "";
    return isActive
      ? { text: `Has a seat${from}`, tone: "success" }
      : { text: `Left the group · still holds a seat${from}`, tone: "muted" };
  }
  if (!member || !isUnlockedAt(member.unlockedUntil)) {
    return { text: "Locked", tone: "muted" };
  }
  if (member.willRenew) return { text: "Unlocked by their own plan", tone: "success" };
  const date = formatAccessDate(member.unlockedUntil as number);
  const until = `Unlocked until ${date}`;
  // Near its end, a countdown instead (which drops the "before this plan
  // ends" — it would read as if about this plan).
  const countdown = formatPlanEnd(
    member.unlockedUntil as number,
    member.willRenew,
    member.unlockDays,
    until
  );
  return unlockEndsEarly(member, plan?.endsAt ?? null)
    ? {
        text: countdown !== until ? countdown : `${until}${plan ? ", before this plan ends" : ""}`,
        tone: "warning",
      }
    : { text: countdown, tone: "success" };
}

// "You", "You and Anna", "You, Anna and Ben", "You, Anna, Ben and 2 more".
const MAX_NAMES_SHOWN = 3;
function joinNames(names: string[]) {
  if (names.length > MAX_NAMES_SHOWN) {
    return `${names.slice(0, MAX_NAMES_SHOWN).join(", ")} and ${names.length - MAX_NAMES_SHOWN} more`;
  }
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// A row's "Give seat" / "Remove seat" button, which shrinks away while its
// confirmation is open below it (and grows back on Cancel) rather than
// vanishing. Its space stays reserved, so the row's text doesn't reflow
// mid-animation.
function SeatButton({
  label,
  tone,
  hidden,
  onPress,
}: {
  label: string;
  tone: "accent" | "danger";
  hidden: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(hidden ? 0 : 1);
  useEffect(() => {
    scale.set(
      withTiming(hidden ? 0 : 1, { duration: EXPAND_DURATION_MS, easing: Easing.inOut(Easing.quad) })
    );
  }, [hidden, scale]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={scaleStyle} pointerEvents={hidden ? "none" : "auto"}>
      <Pressable
        style={[styles.giveButton, tone === "danger" && styles.removeButton]}
        onPress={onPress}
        hitSlop={6}
      >
        <Text style={[styles.giveButtonText, tone === "danger" && styles.removeButtonText]}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

// Stand-in while the group, its plan and its members load — without it, a
// group that already has a plan would first say "Be the first to sponsor".
function GroupPlanSkeleton() {
  return (
    <SkeletonGroup style={styles.content}>
      <View style={styles.planCard}>
        <SkeletonText fontSize={18} width="60%" />
        <SkeletonText fontSize={14} lineHeight={20} width="85%" />
        <SkeletonText fontSize={14} lineHeight={20} width="45%" />
      </View>
      <View style={styles.section}>
        <SkeletonText fontSize={14} width={64} />
        <PlanRowSkeleton titleWidth="45%" filled />
        <PlanRowSkeleton titleWidth="35%" filled />
        <PlanRowSkeleton titleWidth="50%" filled />
      </View>
    </SkeletonGroup>
  );
}

export default function GroupPlanScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { session } = useAuth();
  const viewerId = session?.user.id ?? "";
  const { groups, isLoaded: isGroupsLoaded } = useGroups();
  const group = groups.find((item) => item.id === groupId);
  const { access, refresh: refreshAccess } = useAccess();
  const openUnlockFor = useOpenUnlock();
  const {
    access: groupAccess,
    isLoaded: isGroupAccessLoaded,
    refresh: refreshGroupAccess,
    assignSeats,
    removeSeat,
  } = useGroupAccess(group?.id);
  const { members: allMembers, isLoaded: isMembersLoaded } = useGroupMembers(group?.id);
  const { logs, syncPending } = useLogs();
  // Back from the paywall with a freshly bought plan, this screen's copy of the
  // group's access is stale.
  useRefreshOnRefocus(refreshGroupAccess);
  // The member whose "Give seat" / "Remove seat" is being confirmed in place.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Which confirmation each row last opened, kept after it closes so a
  // closing confirmation keeps its own content while it shrinks away
  // (rather than turning into the other one mid-animation).
  const [seatActions, setSeatActions] = useState<Record<string, "give" | "remove">>({});
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isGroupsLoaded || (group && (!isGroupAccessLoaded || !isMembersLoaded))) {
    return (
      <View style={styles.flex}>
        <ModalHeader title="Group plan" onClose={goBackOrToGroups} />
        <GroupPlanSkeleton />
      </View>
    );
  }

  if (!group) {
    return (
      <View style={styles.flex}>
        <ModalHeader title="Group plan" onClose={goBackOrToGroups} />
        <View style={styles.notFound}>
          <Text style={styles.muted}>This group could not be found.</Text>
        </View>
      </View>
    );
  }

  const plan = groupAccess?.plan ?? null;
  const pendingInGroup = logs.filter(
    (log) => log.groupId === group.id && log.isPending && !log.isHeld
  ).length;
  const freeLeft = freeEntriesLeft(groupAccess, pendingInGroup);
  const viewerLocked =
    entriesNeedUnlock(groupAccess, pendingInGroup) && !isMemberUnlocked(groupAccess, viewerId);
  // A seat on a pass that hasn't started doesn't unlock them yet, but
  // there's nothing to ask for: their row says when it starts.
  const viewerHasSeat = !!groupAccess?.members[viewerId]?.hasSeat;
  // Real accounts only (a deleted account's placeholder can't hold a seat),
  // and someone who left only while they still hold one of its seats.
  const listed = allMembers
    .filter(
      (member) =>
        member.id !== DELETED_USER_ID &&
        (member.isActive || !!groupAccess?.members[member.id]?.hasSeat)
    )
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));
  // The group's sponsor, who hands out the seats (can_manage_plan in
  // schema.sql) — whoever took over if the plan's buyer has left.
  const sponsor = allMembers.find((member) => member.isSponsor && member.isActive);
  const freeSeats = plan ? plan.seatCount - plan.seatsUsed : 0;
  // Until it starts, seats can still be taken back and handed to someone
  // else; after that they're locked in.
  const seatsChangeable = !!plan && isNotStartedYet(plan.startsAt);
  // Whoever is the group's sponsor needs a seat on a pass that hasn't started
  // unless something else unlocks them then — also when they took the role
  // over from a buyer who left (leave_group gives them the buyer's seat, but
  // can't when the pass is full).
  const sponsorAccess = sponsor ? groupAccess?.members[sponsor.id] : undefined;
  const viewerNeedsSponsorSeat =
    seatsChangeable &&
    sponsor?.id === viewerId &&
    !!groupAccess &&
    !sponsorAccess?.hasSeat &&
    !isCoveredAt(sponsorAccess, plan?.startsAt ?? undefined);

  const nameFor = (id: string, name: string) => (id === viewerId ? "You" : name);

  // Who'd get something out of a group plan: everyone still in the group
  // that nothing unlocks yet, you first.
  const withoutPlan = allMembers
    .filter(
      (member) =>
        member.isActive &&
        member.id !== DELETED_USER_ID &&
        !isMemberUnlocked(groupAccess, member.id)
    )
    .sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId));
  const viewerWithoutPlan = withoutPlan.some((member) => member.id === viewerId);
  const withoutPlanText = !groupAccess
    ? null
    : withoutPlan.length === 0
      ? "Everyone here already has a plan of their own."
      : `${joinNames(withoutPlan.map((member) => nameFor(member.id, member.name)))} ${
          withoutPlan.length === 1 && !viewerWithoutPlan ? "doesn't" : "don't"
        } have a plan yet. Get ${
          !viewerWithoutPlan ? "them" : withoutPlan.length === 1 ? "yourself" : "everyone"
        } a seat in this group.`;

  const handleGiveSeat = async (memberId: string) => {
    if (!plan) return;
    setIsBusy(true);
    setError(null);
    const { error: giveError } = await assignSeats(plan.id, [memberId]);
    setIsBusy(false);
    if (giveError) {
      setError(giveError);
      return;
    }
    setConfirmingId(null);
    // Your own unlock may have just changed, and a held entry may have been
    // waiting for exactly this seat.
    await refreshAccess();
    syncPending();
  };

  const handleRemoveSeat = async (memberId: string) => {
    if (!plan) return;
    setIsBusy(true);
    setError(null);
    const { error: removeError } = await removeSeat(plan.id, memberId);
    setIsBusy(false);
    if (removeError) {
      setError(removeError);
      return;
    }
    setConfirmingId(null);
    await refreshAccess();
  };

  const handleUpgrade = async (seatCount: number, period: PlanPeriod | null) => {
    if (!plan) return;
    setIsBusy(true);
    setError(null);
    const result = await upgradePlan({
      canTestPurchase: access.canTestPurchase,
      planId: plan.id,
      seatCount,
      period,
    });
    if (result.error) {
      setIsBusy(false);
      setError(result.error);
      return;
    }
    if (!result.unavailable) {
      // A longer plan also moves its seat holders' unlocks.
      await Promise.all([refreshGroupAccess(), refreshAccess()]);
    }
    setIsBusy(false);
  };

  const openUnlock = () => openUnlockFor({ groupId: group.id });
  const openUnlockJustMe = () => openUnlockFor({ groupId: group.id, justMe: true });

  return (
    <View style={styles.flex}>
      <ModalHeader title="Group plan" onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {plan ? (
          <View style={styles.planCard}>
            <Text style={styles.planTitle}>{groupPlanTitle(plan.kind, plan.startsAt, plan.endsAt)}</Text>
            <Text style={styles.planLine}>
              {isNotStartedYet(plan.startsAt)
                ? `Starts ${formatAccessDate(plan.startsAt as number)}, until ${formatAccessDate(plan.endsAt)}`
                : formatPlanEnd(
                    plan.endsAt,
                    plan.willRenew,
                    plan.durationDays,
                    `${plan.willRenew ? "Renews" : "Until"} ${formatAccessDate(plan.endsAt)}`
                  )}
              {" · "}
              {plan.seatsUsed} of {plan.seatCount} seats used
              {plan.deletedSeats > 0
                ? ` (${plan.deletedSeats} by ${plan.deletedSeats === 1 ? "a deleted account" : "deleted accounts"})`
                : ""}
            </Text>
            <Text style={styles.planLine}>
              {sponsor?.id === viewerId
                ? "You're its sponsor."
                : sponsor
                  ? `${sponsor.name} is its sponsor.`
                  : "The group has no sponsor, so its admins hand out the seats."}
            </Text>
            {plan.canManage && isNotStartedYet(plan.startsAt) ? (
              <Pressable
                onPress={() =>
                  router.push({ pathname: "/plan-setup", params: { planId: plan.id } })
                }
                hitSlop={8}
              >
                <Text style={styles.noteLink}>Change start date</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.planCard}>
            <Text style={styles.planTitle}>Be the first to sponsor {group.name}</Text>
            {withoutPlanText ? <Text style={styles.planLine}>{withoutPlanText}</Text> : null}
            {groupAccess?.paywallEnabled === false ? (
              <Text style={styles.planLine}>
                The paywall is still switched off, so everyone can add entries for now.
              </Text>
            ) : groupAccess && !isMemberUnlocked(groupAccess, viewerId) ? (
              <Text style={styles.planLine}>
                {freeLeft > 0
                  ? `This group has ${freeLeft === 1 ? "1 free entry" : `${freeLeft} free entries`} left. After that, adding an entry needs everyone on it to be unlocked.`
                  : "This group's free entries are used up, so adding an entry needs everyone on it to be unlocked."}
              </Text>
            ) : null}
            <PressableScale style={styles.primaryButton} pressedScale={0.98} onPress={openUnlock}>
              <Text style={styles.primaryButtonText}>Unlock the group</Text>
            </PressableScale>
          </View>
        )}

        {plan && viewerLocked && !viewerHasSeat && !plan.canManage ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>
              You&apos;re locked in this group. Ask{" "}
              {sponsor ? sponsor.name : "an admin"} for a seat, or unlock just
              yourself.
            </Text>
            <Pressable onPress={openUnlockJustMe} hitSlop={8}>
              <Text style={styles.noteLink}>Unlock just me</Text>
            </Pressable>
          </View>
        ) : null}

        {plan && viewerNeedsSponsorSeat ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>
              As the group&apos;s sponsor, you need a seat on this pass: nothing else unlocks you
              when it starts.{" "}
              {freeSeats > 0
                ? "Give yourself one below."
                : "It's full, so take a seat back from someone first, then give yourself one."}
            </Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Members</Text>
          {listed.map((member) => {
            const memberAccess = groupAccess?.members[member.id];
            const status = describeMember(memberAccess, member.isActive, plan);
            const canGive =
              !!plan &&
              plan.canManage &&
              member.isActive &&
              !memberAccess?.hasSeat &&
              freeSeats > 0;
            // The group sponsor's own seat stays while nothing else unlocks
            // them when the pass starts (remove_plan_seat refuses it
            // otherwise) — a renewing subscription always does. The group's
            // sponsor, not the buyer: the duty passes on with the role.
            const isRequiredSponsorSeat =
              member.id === sponsor?.id &&
              !isCoveredAt(memberAccess, plan?.startsAt ?? undefined);
            const canRemove =
              !!plan &&
              plan.canManage &&
              seatsChangeable &&
              !!memberAccess?.hasSeat &&
              !isRequiredSponsorSeat;
            const isConfirming = confirmingId === member.id;
            const confirmAction = seatActions[member.id];
            return (
              <PlanMemberRow
                key={member.id}
                name={member.name}
                label={nameFor(member.id, member.name)}
                avatarUrl={member.avatarUrl}
                isActive={member.isActive}
                status={status.text}
                statusTone={status.tone}
                accessory={
                  canGive || canRemove ? (
                    <SeatButton
                      label={canGive ? "Give seat" : "Remove seat"}
                      tone={canGive ? "accent" : "danger"}
                      hidden={isConfirming}
                      onPress={() => {
                        setError(null);
                        setSeatActions((prev) => ({
                          ...prev,
                          [member.id]: canGive ? "give" : "remove",
                        }));
                        setConfirmingId(member.id);
                      }}
                    />
                  ) : null
                }
              >
                {/* Every row, not just those that can get a seat: right after
                    "Give seat" succeeds, the row can't anymore, and its
                    confirmation should still shrink away rather than vanish. */}
                {plan ? (
                  <Expandable open={isConfirming}>
                    <View style={styles.confirm}>
                      {confirmAction === "remove" ? (
                        <ConfirmationBody
                          message={`${member.id === viewerId ? "Your" : `${member.name}'s`} seat goes back to the pass, free to give to someone else until it starts on ${formatAccessDate(plan.startsAt as number)}.`}
                          confirmLabel="Remove seat"
                          destructive
                          disabled={isBusy}
                          messageInset={0}
                          buttonsInset={0}
                          onCancel={() => setConfirmingId(null)}
                          onConfirm={() => handleRemoveSeat(member.id)}
                        />
                      ) : (
                        <ConfirmationBody
                          message={
                            seatsChangeable
                              ? `${member.id === viewerId ? "You get" : `${member.name} gets`} a seat from ${formatAccessDate(plan.startsAt as number)} until ${formatAccessDate(plan.endsAt)}. You can still change who has a seat until then; after that it stays ${member.id === viewerId ? "yours" : "theirs"} for the whole pass.`
                              : `${member.id === viewerId ? "You get" : `${member.name} gets`} a seat until ${formatAccessDate(plan.endsAt)}${plan.willRenew ? ", renewing with the plan" : ""}. It stays ${member.id === viewerId ? "yours" : "theirs"} for the whole plan, even if ${member.id === viewerId ? "you leave" : "they leave"} the group.`
                          }
                          confirmLabel="Give seat"
                          disabled={isBusy}
                          messageInset={0}
                          buttonsInset={0}
                          onCancel={() => setConfirmingId(null)}
                          onConfirm={() => handleGiveSeat(member.id)}
                        />
                      )}
                    </View>
                  </Expandable>
                ) : null}
              </PlanMemberRow>
            );
          })}
        </View>

        {plan?.canManage ? (
          <View style={styles.section}>
            <Text style={styles.hint}>
              {seatsChangeable
                ? `${freeSeats === 1 ? "1 seat" : `${freeSeats} seats`} free. Until the pass starts on ${formatAccessDate(plan.startsAt as number)}, you can take a seat back and give it to someone else. After that, a seat stays with its holder for the whole pass.`
                : freeSeats > 0
                  ? `${freeSeats === 1 ? "1 seat" : `${freeSeats} seats`} free. A seat stays with its holder for the whole plan, even if they leave the group.`
                  : "Every seat is taken. Upgrade the plan for someone who joined late, or they can unlock themselves."}
            </Text>
            <PlanUpgradeCard
              key={`${plan.id}-${plan.seatCount}-${plan.endsAt}`}
              plan={plan}
              canTestPurchase={access.canTestPurchase}
              isBusy={isBusy}
              onUpgrade={handleUpgrade}
            />
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  muted: {
    fontSize: 15,
    color: Colors.muted,
  },
  content: {
    padding: 20,
    gap: 20,
  },
  planCard: {
    gap: 6,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  planTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  planLine: {
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
  hint: {
    fontSize: 13,
    lineHeight: 18,
    color: Colors.muted,
  },
  giveButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  giveButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.accent,
  },
  removeButton: {
    borderColor: Colors.danger,
  },
  removeButtonText: {
    color: Colors.danger,
  },
  confirm: {
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  primaryButton: {
    marginTop: 8,
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
  error: {
    fontSize: 14,
    color: Colors.danger,
  },
});
