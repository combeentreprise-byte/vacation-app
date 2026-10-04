import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { CrossfadeLabel } from "@/components/crossfade-label";
import { GroupHero } from "@/components/hero-motive";
import { type LeaveGroupRequest, LeaveGroupPopup } from "@/components/leave-group-popup";
import { PinIcon } from "@/components/pin-icon";
import { PressableScale } from "@/components/press-feedback";
import { GroupListSkeleton } from "@/components/screen-skeletons";
import { Colors } from "@/constants/colors";
import { GROUP_CARD_HEIGHT_RATIO, GROUP_LIST_PADDING } from "@/constants/layout";
import { MAX_PINNED_GROUPS } from "@/constants/limits";
import { useAccess } from "@/hooks/use-access";
import { type Group, useGroups } from "@/hooks/use-groups";
import { usePaywallNudge } from "@/hooks/use-paywall-nudge";
import { supabase } from "@/lib/supabase";
import { isNotStartedYet, isViewerLocked } from "@/utils/access";

const LEAVE_SLOT_WIDTH = 44;
// useWindowDimensions (not Dimensions.get) for the card height, so it
// re-measures on rotation/resize instead of freezing at mount.
const CARD_HEIGHT_RATIO = GROUP_CARD_HEIGHT_RATIO;
const LIST_PADDING = GROUP_LIST_PADDING;
const MANAGE_ANIMATION = { duration: 280, easing: Easing.out(Easing.cubic) };

export default function GroupScreen() {
  const { groups, isLoaded, removeGroup, setGroupPinned } = useGroups();
  const { access } = useAccess();
  // Now and then, the paywall for someone still locked.
  usePaywallNudge();
  const [isManaging, setIsManaging] = useState(false);
  // Driven on the UI thread (Reanimated) so the slide stays smooth even while
  // toggling Manage mode re-renders every row on the JS thread.
  const manageProgress = useSharedValue(0);
  // The group whose leave icon was tapped, plus what LeaveGroupPopup needs
  // to show its confirmation (it only reads `anchor` and `isLastMember`).
  const [leaveTarget, setLeaveTarget] = useState<
    (LeaveGroupRequest & { group: Group }) | null
  >(null);
  const { height: windowHeight } = useWindowDimensions();
  const cardHeight = windowHeight * CARD_HEIGHT_RATIO;
  // Manage mode shrinks each card's width (the pin/leave slot slides in on its
  // left) — pinning the hero to the card's full, un-shrunk width and its right
  // edge means that animation only changes the card's clipping frame, instead
  // of re-laying-out and redrawing every motive SVG on every frame. Measured
  // from the list itself (not the window) so it holds on wide web layouts too.
  const [listWidth, setListWidth] = useState<number | null>(null);
  const heroStyle = useMemo(
    () =>
      listWidth === null
        ? styles.cardPhotoArea
        : [styles.cardPhotoAreaPinned, { width: listWidth - LIST_PADDING * 2 }],
    [listWidth]
  );

  // The tabs are a swipeable pager that keeps every tab mounted, so without
  // this, Manage mode (and any open leave confirmation) would still be open
  // when the user comes back from another tab.
  useFocusEffect(
    useCallback(() => {
      return () => {
        setIsManaging(false);
        setLeaveTarget(null);
        cancelAnimation(manageProgress);
        manageProgress.set(0);
      };
    }, [manageProgress])
  );

  const handleCreate = () => {
    router.push("/new-group");
  };

  // Active member count per group, fetched in one query when Manage mode
  // opens so tapping a leave icon can open its confirmation instantly instead
  // of waiting on a per-group lookup (handleLeave falls back to one if this
  // hasn't arrived yet).
  const [activeMemberCounts, setActiveMemberCounts] = useState<Record<string, number> | null>(null);

  const prefetchActiveMemberCounts = async () => {
    setActiveMemberCounts(null);
    const { data, error } = await supabase
      .from("group_members")
      .select("group_id")
      .in("group_id", groups.map((group) => group.id))
      .is("left_at", null);
    if (error) return;
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      counts[row.group_id] = (counts[row.group_id] ?? 0) + 1;
    }
    setActiveMemberCounts(counts);
  };

  const toggleManaging = () => {
    const next = !isManaging;
    setIsManaging(next);
    if (next) prefetchActiveMemberCounts();
    manageProgress.set(withTiming(next ? 1 : 0, MANAGE_ANIMATION));
  };

  const handleTogglePin = async (group: Group) => {
    const pinned = group.pinnedAt === null;
    // Same cap set_group_pinned enforces server-side — checked here too just
    // so the user gets an explanation instead of a silent snap-back.
    if (pinned && groups.filter((g) => g.pinnedAt !== null).length >= MAX_PINNED_GROUPS) {
      Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_GROUPS} groups. Unpin one first.`);
      return;
    }
    const { error } = await setGroupPinned(group.id, pinned);
    if (error) Alert.alert("Couldn't pin group", error);
  };

  const handleLeave = async (group: Group, event: GestureResponderEvent) => {
    // Read before the await — the event isn't guaranteed to still hold its
    // coordinates once the handler has yielded.
    const anchor = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
    // Best-effort check for which confirmation copy to show; leave_group
    // itself (schema.sql) makes the actual delete-vs-leave call server-side,
    // so a stale count here can't cause the wrong thing to happen, only the
    // wrong warning to be shown for it.
    let count = activeMemberCounts?.[group.id];
    if (count === undefined) {
      const result = await supabase
        .from("group_members")
        .select("user_id", { count: "exact", head: true })
        .eq("group_id", group.id)
        .is("left_at", null);
      count = result.count ?? 1;
    }
    // Leaving before the group's pass starts gives up your seat on it
    // (free_pending_plan_seat), so the confirmation says so.
    const pendingSeat = access.upcomingPlans.find(
      (plan) => plan.groupId === group.id && plan.hasSeat && isNotStartedYet(plan.startsAt)
    );
    setLeaveTarget({
      group,
      anchor,
      isLastMember: count <= 1,
      isSponsor: group.isSponsor,
      seatStartsAt: pendingSeat?.startsAt ?? null,
    });
  };

  const handleConfirmLeave = () => {
    if (!leaveTarget) return;
    setLeaveTarget(null);
    removeGroup(leaveTarget.group.id);
    if (groups.length === 1) {
      setIsManaging(false);
      cancelAnimation(manageProgress);
      manageProgress.set(0);
    }
  };

  if (!isLoaded) {
    return <GroupListSkeleton />;
  }

  if (groups.length === 0) {
    return (
      <>
        <View style={styles.container}>
          <Pressable onPress={handleCreate} hitSlop={12}>
            <Ionicons name="add" size={28} color={Colors.muted} />
          </Pressable>
          <Pressable onPress={handleCreate}>
            <Text style={styles.createText}>Create a group</Text>
          </Pressable>
        </View>
        <PaywallButton />
      </>
    );
  }

  return (
    <>
      <FlatList<Group>
        data={groups}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        onLayout={(event) => setListWidth(event.nativeEvent.layout.width)}
        extraData={isManaging}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Pressable onPress={toggleManaging} hitSlop={8}>
              <CrossfadeLabel
                first="Manage groups"
                second="Done"
                showSecond={isManaging}
                style={styles.manageText}
              />
            </Pressable>
            <Pressable onPress={handleCreate} hitSlop={12}>
              <Ionicons name="add" size={24} color={Colors.accent} />
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <ManageSlot progress={manageProgress} isManaging={isManaging}>
              <Pressable
                onPress={() => handleTogglePin(item)}
                hitSlop={8}
                accessibilityLabel={item.pinnedAt === null ? "Pin group" : "Unpin group"}
              >
                {/* Shows the action a tap performs: crossed out on a pinned
                    group (unpin), plain on an unpinned one (pin). */}
                <PinIcon size={22} color={Colors.text} crossed={item.pinnedAt !== null} />
              </Pressable>
              <Pressable
                onPress={(event) => handleLeave(item, event)}
                hitSlop={8}
                accessibilityLabel="Leave group"
              >
                <Ionicons name="log-out-outline" size={22} color={Colors.danger} />
              </Pressable>
            </ManageSlot>
            <Pressable
              style={[styles.card, { height: cardHeight }]}
              onPress={() => router.push({ pathname: "/group/[id]", params: { id: item.id } })}
            >
              {/* The card body itself stands in for a future decorative photo
                  (see cardPhotoArea) — the ribbon just sits on top of it. */}
              <GroupHero
                photoUrl={item.photoUrl}
                motive={item.heroMotive}
                hue={item.heroHue}
                verticalAlign="top"
                style={heroStyle}
              />
              <View style={styles.cardRibbon}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.pinnedAt !== null && (
                  <PinIcon size={20} color={Colors.text} />
                )}
              </View>
            </Pressable>
          </View>
        )}
      />
      <LeaveGroupPopup
        request={leaveTarget}
        onClose={() => setLeaveTarget(null)}
        onConfirm={handleConfirmLeave}
      />
      <PaywallButton />
    </>
  );
}

// A shortcut to the paywall, floating over the group list, for anyone still
// locked — what usePaywallNudge opens on its own only every few days. In
// development it's always there, and always with all three pages.
function PaywallButton() {
  const { access, isLoaded } = useAccess();
  if (!__DEV__ && !(isLoaded && access.paywallEnabled && isViewerLocked(access))) return null;
  return (
    <PressableScale
      style={styles.paywallButton}
      onPress={() => router.push({ pathname: "/paywall", params: __DEV__ ? { full: "1" } : {} })}
      accessibilityRole="button"
      accessibilityLabel="Open paywall"
    >
      <Ionicons name="diamond-outline" size={22} color={Colors.accentText} />
    </PressableScale>
  );
}

// The pin/leave column that slides in on each card's left in Manage mode. Its
// icons sit in a fixed-width column pinned to the slot's right edge, so as the
// slot widens they glide in alongside the card instead of being squeezed.
function ManageSlot({
  progress,
  isManaging,
  children,
}: {
  progress: SharedValue<number>;
  isManaging: boolean;
  children: React.ReactNode;
}) {
  const slotStyle = useAnimatedStyle(() => ({
    width: progress.value * LEAVE_SLOT_WIDTH,
  }));
  const iconsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.3, 1], [0, 1], "clamp"),
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-8, 0]) }],
  }));
  return (
    <Animated.View style={[styles.leaveSlot, slotStyle]} pointerEvents={isManaging ? "auto" : "none"}>
      <Animated.View style={[styles.leaveSlotIcons, iconsStyle]}>{children}</Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  paywallButton: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.accent,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  createText: {
    color: Colors.muted,
    fontSize: 15,
  },
  list: {
    padding: LIST_PADDING,
    gap: 12,
  },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  manageText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: "500",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  leaveSlot: {
    alignSelf: "stretch",
    alignItems: "flex-end",
    justifyContent: "center",
    overflow: "hidden",
  },
  leaveSlotIcons: {
    width: LEAVE_SLOT_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
  },
  card: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  // Stands in for a future decorative photo — an <Image> can drop in here
  // later without touching the ribbon that sits on top of it.
  cardPhotoArea: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  cardPhotoAreaPinned: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
  },
  cardRibbon: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.background,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
});
