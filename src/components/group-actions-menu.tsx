import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import {
  Animated,
  Dimensions,
  type LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Reanimated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import {
  LEAVE_CONFIRMATION_PADDING_X,
  LEAVE_CONFIRMATION_WIDTH,
  LeaveGroupConfirmationBody,
  leaveConfirmationTitle,
} from "@/components/leave-group-confirmation";
import type { MenuAnchor } from "@/components/menu-anchor";
import { Colors } from "@/constants/colors";
import { popupScaleStyle, usePopupAnimation } from "@/hooks/use-popup-animation";

const MENU_WIDTH = 210;
const CONFIRM_WIDTH = LEAVE_CONFIRMATION_WIDTH;
const MORPH_DURATION_MS = 260;
const ROW_PADDING_X = LEAVE_CONFIRMATION_PADDING_X;
const ICON_SIZE = 18;
const ICON_GAP = 12;

type IoniconName = ComponentProps<typeof Ionicons>["name"];

type GroupActionsMenuProps = {
  anchor: MenuAnchor | null;
  onClose: () => void;
  onEdit: () => void;
  onInvite: () => void;
  // Opens the group's plan (see group-plan.tsx). Left out while plans aren't
  // shown at all, which hides the row.
  onPlan?: () => void;
  // Called once the user confirms in the menu's own leave confirmation —
  // tapping "Leave group" morphs the menu into that confirmation in place
  // rather than opening a separate alert.
  onLeave: () => void;
  // Fires once the menu's Modal has fully finished closing, including its
  // native dismissal (not just when `anchor` goes null), for actions that must present something native
  // only after it's gone — see handleInvite in group/[id].tsx.
  onClosed?: () => void;
  // Editing name/description/currency is admin-only; non-admins see the
  // option grayed out and untappable rather than seeing it fail after tapping it.
  canEdit: boolean;
  // Switches the confirmation copy to warn that leaving deletes the group.
  isLastMember: boolean;
  // Adds that the sponsor role passes on for good (see leave_group).
  isSponsor: boolean;
  // Adds that leaving gives up the viewer's seat on the group's pass
  // starting then (see LeaveGroupConfirmationBody).
  seatStartsAt: number | null;
};

export function GroupActionsMenu({
  anchor,
  onClose,
  onEdit,
  onInvite,
  onPlan,
  onLeave,
  onClosed,
  canEdit,
  isLastMember,
  isSponsor,
  seatStartsAt,
}: GroupActionsMenuProps) {
  const { isMounted, progress } = usePopupAnimation(
    !!anchor,
    // On iOS the Modal is still being dismissed natively for a moment after
    // React stops rendering it, and anything presented in that window (like
    // the share sheet) is silently dropped — so there, onClosed waits for the
    // Modal's own onDismiss below, which only fires once that has finished.
    // onDismiss is iOS-only, so every other platform uses the animation end.
    Platform.OS === "ios" ? undefined : onClosed
  );
  const [isConfirmingLeave, setIsConfirmingLeave] = useState(false);
  // The confirmation's message/buttons stay mounted until the morph back to
  // the menu (after Cancel) has finished, so they fade out with it rather
  // than vanishing at its start — and are then unmounted rather than left
  // invisible, since on web their text keeps `pointer-events: auto` and
  // would swallow taps meant for the menu rows.
  const [showDetails, setShowDetails] = useState(false);
  // Whether dropping out of the confirmation should snap (a fresh open,
  // with nothing to animate from) rather than animate (Cancel).
  const [snapBack, setSnapBack] = useState(false);
  // Kept in sync only while anchor is set, so the box doesn't jump to the
  // top-left corner while it animates closed (the Modal stays mounted for
  // that whole animation — see usePopupAnimation). Set directly during
  // render (not an effect) per React's documented pattern for adjusting
  // state in response to a prop change. A new anchor means a fresh open,
  // so it also drops back out of a confirmation left over from last time.
  const [displayAnchor, setDisplayAnchor] = useState(anchor);
  if (anchor && anchor !== displayAnchor) {
    setDisplayAnchor(anchor);
    setIsConfirmingLeave(false);
    setSnapBack(true);
  }

  const startConfirmingLeave = () => {
    setIsConfirmingLeave(true);
    setShowDetails(true);
    setSnapBack(false);
  };

  // One value drives the whole menu → confirmation morph: the box widens,
  // the rows above "Leave group" collapse away, the label slides into place
  // and restyles as the title, and the message/buttons expand in below it.
  // Everything is animated explicitly off this rather than with layout
  // transitions, which on web animate size changes by scaling — visibly
  // squishing the text mid-morph. Cancel animates back to the menu; a fresh
  // open snaps there instead (see snapBack).
  const morph = useSharedValue(0);
  useEffect(() => {
    morph.value =
      !isConfirmingLeave && snapBack
        ? 0
        : withTiming(isConfirmingLeave ? 1 : 0, { duration: MORPH_DURATION_MS });
  }, [isConfirmingLeave, snapBack, morph]);
  useEffect(() => {
    if (isConfirmingLeave) return;
    const timeout = setTimeout(() => setShowDetails(false), MORPH_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [isConfirmingLeave]);

  // The collapsing rows and expanding details are sized from their measured
  // natural heights. Neither measurement may ever be taken from a view
  // squeezed by the very height it drives — on native that's a feedback loop
  // (measure → resize → re-measure...) that makes the whole popup jitter
  // between two layouts. So the rows above "Leave group" are only measured
  // while the menu is showing normally (unconstrained, height "auto"), and
  // the details are absolutely positioned inside their wrapper, which keeps
  // their own layout independent of the wrapper's animated height.
  // (Checked against the morph itself, not just isConfirmingLeave, since the
  // rows are still squeezed while animating back after Cancel.)
  const topNaturalHeight = useSharedValue(0);
  const onTopLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (morph.value === 0 && height > 0) topNaturalHeight.value = height;
  };
  const topSectionStyle = useAnimatedStyle(() => {
    const amount = 1 - morph.value;
    return {
      height: morph.value === 0 ? "auto" : topNaturalHeight.value * amount,
      // Squared so content fades out ahead of (and in behind) the height
      // change, rather than being visibly clipped mid-fade.
      opacity: amount * amount,
    };
  });

  const detailsNaturalHeight = useSharedValue(0);
  const onDetailsLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) detailsNaturalHeight.value = height;
  };
  const detailsStyle = useAnimatedStyle(() => {
    const amount = interpolate(morph.value, [0.4, 1], [0, 1], "clamp");
    return { height: detailsNaturalHeight.value * amount, opacity: amount * amount };
  });

  const boxWidthStyle = useAnimatedStyle(() => ({
    width: MENU_WIDTH + morph.value * (CONFIRM_WIDTH - MENU_WIDTH),
  }));
  // Gone before the sliding label reaches it.
  const leaveIconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(morph.value, [0, 0.3], [1, 0], "clamp"),
  }));
  const leaveLabelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(morph.value, [0, 1], [Colors.danger, Colors.text]),
    fontSize: 15 + morph.value * 2,
    // Starts past the icon, ends flush left where the title sits.
    transform: [{ translateX: (1 - morph.value) * (ICON_SIZE + ICON_GAP) }],
  }));

  // Anchored by its right edge so the box grows leftward, away from the
  // three-dots button, when it widens into the confirmation.
  const screenWidth = Dimensions.get("window").width;
  const right = displayAnchor
    ? Math.min(
        Math.max(12, screenWidth - displayAnchor.x - 16),
        screenWidth - CONFIRM_WIDTH - 12
      )
    : 0;

  const items: {
    key: string;
    icon: IoniconName;
    label: string;
    // Optical nudge for glyphs whose visual weight sits off-center in their
    // box, so every icon's mass lines up in one column with the others.
    iconOffsetX?: number;
    disabled?: boolean;
    onPress: () => void;
  }[] = [
    { key: "edit", icon: "create-outline", label: "Edit group", disabled: !canEdit, onPress: onEdit },
    // person-add-outline's body sits ~1px right of center to make room for
    // its "+", compared to create-outline and log-out-outline.
    { key: "invite", icon: "person-add-outline", label: "Invite member", iconOffsetX: -1, onPress: onInvite },
    ...(onPlan ? [{ key: "plan", icon: "ticket-outline" as const, label: "Group plan", onPress: onPlan }] : []),
  ];

  return (
    <Modal
      transparent
      visible={isMounted}
      animationType="none"
      onRequestClose={onClose}
      onDismiss={Platform.OS === "ios" ? onClosed : undefined}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}
      />
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        {displayAnchor ? (
          <Animated.View
            pointerEvents="box-none"
            style={[styles.anchorFrame, { top: displayAnchor.y + 8, right }, popupScaleStyle(progress)]}
          >
            <Reanimated.View
              // Swallows taps on the box itself (e.g. on the confirmation
              // text) so they don't fall through to the backdrop and close it.
              onStartShouldSetResponder={() => true}
              style={[styles.box, boxWidthStyle]}
            >
              <Reanimated.View
                style={[styles.collapsible, topSectionStyle]}
                pointerEvents={isConfirmingLeave ? "none" : "auto"}
              >
                <View onLayout={onTopLayout}>
                  {items.map((item) => (
                    <Pressable
                      key={item.key}
                      style={[styles.item, item.disabled && styles.itemDisabled]}
                      onPress={item.onPress}
                      disabled={item.disabled}
                    >
                      <Ionicons
                        name={item.icon}
                        size={ICON_SIZE}
                        color={Colors.muted}
                        style={item.iconOffsetX ? { transform: [{ translateX: item.iconOffsetX }] } : undefined}
                      />
                      <Text style={styles.itemText} numberOfLines={1}>
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                  <View style={styles.divider} />
                </View>
              </Reanimated.View>

              <Pressable
                style={styles.item}
                onPress={startConfirmingLeave}
                disabled={isConfirmingLeave}
              >
                <Reanimated.View style={[styles.leaveIcon, leaveIconStyle]}>
                  <Ionicons name="log-out-outline" size={ICON_SIZE} color={Colors.danger} />
                </Reanimated.View>
                <Reanimated.Text
                  style={[styles.itemText, isConfirmingLeave && styles.titleText, leaveLabelStyle]}
                  numberOfLines={1}
                >
                  {isConfirmingLeave ? leaveConfirmationTitle(isLastMember) : "Leave group"}
                </Reanimated.Text>
              </Pressable>

              {showDetails ? (
                <Reanimated.View
                  style={[styles.collapsible, detailsStyle]}
                  pointerEvents={isConfirmingLeave ? "auto" : "none"}
                >
                  {/* Laid out at the final width from the start, so its
                      measured height doesn't shift as the box widens. */}
                  <View style={styles.details} onLayout={onDetailsLayout}>
                    <LeaveGroupConfirmationBody
                      isLastMember={isLastMember}
                      isSponsor={isSponsor}
                      seatStartsAt={seatStartsAt}
                      onCancel={() => setIsConfirmingLeave(false)}
                      onConfirm={onLeave}
                    />
                  </View>
                </Reanimated.View>
              ) : null}
            </Reanimated.View>
          </Animated.View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // A light dim (the member/log detail popups use a heavier one) so the
  // popup lifts off same-colored content behind it while still reading as
  // attached to the button it came from.
  backdrop: {
    backgroundColor: "rgba(17, 24, 28, 0.18)",
  },
  // Fixed at the confirmation's width with the box right-aligned inside, so
  // this frame never resizes — only the box does, which keeps the box's
  // right edge put while it widens.
  anchorFrame: {
    position: "absolute",
    width: CONFIRM_WIDTH,
    alignItems: "flex-end",
    transformOrigin: "top right",
  },
  box: {
    paddingVertical: 6,
    backgroundColor: Colors.background,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 14,
  },
  collapsible: {
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: ICON_GAP,
    paddingVertical: 12,
    paddingHorizontal: ROW_PADDING_X,
  },
  itemDisabled: {
    opacity: 0.5,
  },
  itemText: {
    fontSize: 15,
    fontWeight: "500",
    color: Colors.text,
  },
  // Absolutely placed so the label (not the icon) owns the row's layout
  // position — the label's own translateX then carries it past the icon in
  // the menu and back flush left as the title.
  leaveIcon: {
    position: "absolute",
    left: ROW_PADDING_X,
  },
  titleText: {
    fontWeight: "700",
  },
  details: {
    position: "absolute",
    top: 0,
    left: 0,
    width: CONFIRM_WIDTH,
  },
  divider: {
    height: 1,
    marginHorizontal: 14,
    marginVertical: 4,
    backgroundColor: Colors.border,
  },
});
