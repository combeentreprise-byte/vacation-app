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
import { Colors } from "@/constants/colors";
import { groupPlanTitle, type PlanPeriod } from "@/constants/plans";
import { useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { type GroupPlan, type MemberAccess, useGroupAccess } from "@/hooks/use-group-access";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import { useRefreshOnRefocus } from "@/hooks/use-refresh-on-refocus";
import {
  entriesNeedUnlock,
  formatAccessDate,
  freeEntriesLeft,
  isMemberUnlocked,
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
    return isActive
      ? { text: "Has a seat", tone: "success" }
      : { text: "Left the group · still holds a seat", tone: "muted" };
  }
  if (!member || !isUnlockedAt(member.unlockedUntil)) {
    return { text: "Locked", tone: "muted" };
  }
  if (member.willRenew) return { text: "Unlocked by their own plan", tone: "success" };
  const until = `Unlocked until ${formatAccessDate(member.unlockedUntil as number)}`;
  return unlockEndsEarly(member, plan?.endsAt ?? null)
    ? { text: `${until}${plan ? ", before this plan ends" : ""}`, tone: "warning" }
    : { text: until, tone: "success" };
}

// A row's "Give seat" button, which shrinks away while its confirmation is
// open below it (and grows back on Cancel) rather than vanishing. Its space
// stays reserved, so the row's text doesn't reflow mid-animation.
function GiveSeatButton({ hidden, onPress }: { hidden: boolean; onPress: () => void }) {
  const scale = useSharedValue(hidden ? 0 : 1);
  useEffect(() => {
    scale.set(
      withTiming(hidden ? 0 : 1, { duration: EXPAND_DURATION_MS, easing: Easing.inOut(Easing.quad) })
    );
  }, [hidden, scale]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={scaleStyle} pointerEvents={hidden ? "none" : "auto"}>
      <Pressable style={styles.giveButton} onPress={onPress} hitSlop={6}>
        <Text style={styles.giveButtonText}>Give seat</Text>
      </Pressable>
    </Animated.View>
  );
}

export default function GroupPlanScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { session } = useAuth();
  const viewerId = session?.user.id ?? "";
  const { groups } = useGroups();
  const group = groups.find((item) => item.id === groupId);
  const { access, refresh: refreshAccess } = useAccess();
  const { access: groupAccess, refresh: refreshGroupAccess, assignSeats } = useGroupAccess(group?.id);
  const { members: allMembers } = useGroupMembers(group?.id);
  const { logs, syncPending } = useLogs();
  // Back from /unlock with a freshly bought plan, this screen's copy of the
  // group's access is stale.
  useRefreshOnRefocus(refreshGroupAccess);
  // The member whose "Give seat" is being confirmed in place.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // Real accounts only (a deleted account's placeholder can't hold a seat),
  // and someone who left only while they still hold one of its seats.
  const listed = allMembers
    .filter(
      (member) =>
        member.id !== DELETED_USER_ID &&
        (member.isActive || !!groupAccess?.members[member.id]?.hasSeat)
    )
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));
  const sponsor = allMembers.find((member) => member.id === plan?.sponsorId);
  const freeSeats = plan ? plan.seatCount - plan.seatsUsed : 0;

  const nameFor = (id: string, name: string) => (id === viewerId ? "You" : name);

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

  const openUnlock = () => router.push({ pathname: "/unlock", params: { groupId: group.id } });

  return (
    <View style={styles.flex}>
      <ModalHeader title="Group plan" onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {plan ? (
          <View style={styles.planCard}>
            <Text style={styles.planTitle}>{groupPlanTitle(plan.kind, plan.startsAt, plan.endsAt)}</Text>
            <Text style={styles.planLine}>
              {plan.willRenew
                ? `Renews ${formatAccessDate(plan.endsAt)}`
                : `Until ${formatAccessDate(plan.endsAt)}`}
              {" · "}
              {plan.seatsUsed} of {plan.seatCount} seats used
              {plan.deletedSeats > 0
                ? ` (${plan.deletedSeats} by ${plan.deletedSeats === 1 ? "a deleted account" : "deleted accounts"})`
                : ""}
            </Text>
            <Text style={styles.planLine}>
              {plan.sponsorId === viewerId
                ? "You're its sponsor."
                : sponsor?.isActive
                  ? `${sponsor.name} is its sponsor.`
                  : "Its sponsor has left, so the group's admins hand out its seats."}
            </Text>
          </View>
        ) : (
          <View style={styles.planCard}>
            <Text style={styles.planTitle}>No one has unlocked {group.name} yet</Text>
            <Text style={styles.planLine}>
              {groupAccess?.paywallEnabled === false
                ? "The paywall is still switched off, so everyone can add entries for now."
                : isMemberUnlocked(groupAccess, viewerId)
                  ? "You're unlocked. Unlocking the group gives the others a seat too."
                  : freeLeft > 0
                    ? `You have ${freeLeft === 1 ? "1 free entry" : `${freeLeft} free entries`} left in this group. After that, adding an entry needs everyone on it to be unlocked.`
                    : "Your free entries in this group are used up, so adding an entry needs everyone on it to be unlocked."}
            </Text>
            <PressableScale style={styles.primaryButton} pressedScale={0.98} onPress={openUnlock}>
              <Text style={styles.primaryButtonText}>Unlock the group</Text>
            </PressableScale>
          </View>
        )}

        {plan && viewerLocked && !plan.canManage ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>
              You&apos;re locked in this group. Ask{" "}
              {sponsor?.isActive ? sponsor.name : "an admin"} for a seat, or unlock just
              yourself.
            </Text>
            <Pressable onPress={openUnlock} hitSlop={8}>
              <Text style={styles.noteLink}>Unlock just me</Text>
            </Pressable>
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
            const isConfirming = confirmingId === member.id;
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
                  canGive ? (
                    <GiveSeatButton
                      hidden={isConfirming}
                      onPress={() => {
                        setError(null);
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
                      <ConfirmationBody
                        message={`${member.id === viewerId ? "You get" : `${member.name} gets`} a seat until ${formatAccessDate(plan.endsAt)}${plan.willRenew ? ", renewing with the plan" : ""}. It stays ${member.id === viewerId ? "yours" : "theirs"} for the whole plan, even if ${member.id === viewerId ? "you leave" : "they leave"} the group.`}
                        confirmLabel="Give seat"
                        disabled={isBusy}
                        messageInset={0}
                        buttonsInset={0}
                        onCancel={() => setConfirmingId(null)}
                        onConfirm={() => handleGiveSeat(member.id)}
                      />
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
              {freeSeats > 0
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
