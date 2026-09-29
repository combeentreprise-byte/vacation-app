import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import type {
  NavigationProp,
  NavigationState as RouterNavigationState,
  ParamListBase,
} from "expo-router/react-navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Share,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Reanimated, {
  interpolate,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import {
  type NavigationState,
  type SceneRendererProps,
  TabView,
} from "react-native-tab-view";

import { Avatar } from "@/components/avatar";
import { FlagIcon } from "@/components/currency-picker";
import { GroupActionsMenu } from "@/components/group-actions-menu";
import { GroupHero } from "@/components/hero-motive";
import { ConfirmationBody } from "@/components/leave-group-confirmation";
import type { MenuAnchor } from "@/components/menu-anchor";
import { PageHeader } from "@/components/page-header";
import { Colors } from "@/constants/colors";
import { CURRENCIES } from "@/constants/currencies";
import { useAuth } from "@/hooks/use-auth";
import { type GroupMember, useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { type LogEntry, useLogs } from "@/hooks/use-logs";
import { useProfile } from "@/hooks/use-profile";
import { calculateMemberBalances, DELETED_USER_ID } from "@/utils/balances";
import { goBackOrToGroups } from "@/utils/navigation";

type TabRoute = { key: "members" | "logs"; title: string };

// useNavigation's default typing leaves out the native stack's own events,
// including the transitionEnd this screen waits on.
type StackScreenNavigation = NavigationProp<
  ParamListBase,
  string,
  string | undefined,
  RouterNavigationState<ParamListBase>,
  object,
  { transitionEnd: { data: { closing: boolean } } }
>;

function shareInviteLink(groupId: string) {
  const url = Linking.createURL(`join/${groupId}`);
  Share.share({ message: url }).catch((error) => {
    Alert.alert("Couldn't open share sheet", String(error));
  });
}

const TAB_ROUTES: TabRoute[] = [
  { key: "members", title: "Members" },
  { key: "logs", title: "Logs" },
];

// The hero photo placeholder's collapsed height (same idea as the group
// list's fixed-ratio cards, just sized for a full-bleed detail-page hero
// rather than a small list row).
const HERO_HEIGHT_RATIO = 0.28;

// The summary bar's own height above insets.bottom (its text is centered
// within this + the inset) â€” used to lift the FAB clear of it,
// since the bar itself has no ListFooter/layout the FAB could measure.
const SUMMARY_BAR_HEIGHT = 50;

// How many lines a collapsed description shows before offering "Show more".
const DESCRIPTION_COLLAPSED_LINES = 4;
// Matches styles.description's lineHeight â€” used to compute the collapsed
// pixel height a measured description is compared against (see
// descriptionMeasure below). Kept as a constant rather than read back from
// the stylesheet since RN style objects aren't guaranteed to round-trip.
const DESCRIPTION_LINE_HEIGHT = 21;
const DESCRIPTION_COLLAPSED_HEIGHT = DESCRIPTION_COLLAPSED_LINES * DESCRIPTION_LINE_HEIGHT;
// Height of the gradient that softens the description box's clipped bottom
// edge (see DescriptionFade).
const DESCRIPTION_FADE_HEIGHT = Math.round(DESCRIPTION_LINE_HEIGHT * 1.5);
// react-native-web's default text wrapping (like a browser's) only breaks at
// spaces, so a long unbroken run of characters (a URL, a typo with no
// spaces) overflows its box instead of wrapping â€” and since the description
// box above now clips with overflow:hidden for the collapse animation, that
// overflow reads as a letter getting sliced off at the right edge rather
// than just spilling out. `wordBreak` isn't in React Native's TextStyle
// type (it's a web-only CSS property RNW passes through as-is), so it's
// applied only on web via a cast rather than baked into styles.description.
// Native's own text layout already breaks long words onto a new line
// without this.
const webWordBreakStyle: TextStyle =
  Platform.OS === "web" ? ({ wordBreak: "break-word" } as unknown as TextStyle) : {};

// The FAB sits floating above the summary bar (see styles.fab's own bottom
// offset, which stacks this margin + its diameter on top of
// SUMMARY_BAR_HEIGHT), so anything a list needs to clear at the bottom of
// the screen has to clear the FAB too, not just the bar underneath it.
const FAB_BOTTOM_MARGIN = 20;
const FAB_DIAMETER = 56;
// Total obstructed height at the very bottom of the screen, insets.bottom
// aside (that part varies per-device and gets added at each call site) â€”
// the real geometry only (summary bar + the FAB floating above it), with no
// extra padding baked in. A flat safety margin on top of this used to be
// applied unconditionally (48, then 148px), which is what actually caused
// the "half the phone is whitespace" complaint once scrolled to the true
// bottom of a collapsible list â€” a fixed pixel value that was way oversized
// relative to a shorter device's screen. The visible gap below the last row
// is now added at the call site as a fraction of the actual device height
// instead, so it scales down on smaller screens instead of dominating them.
const BOTTOM_OBSTRUCTION_HEIGHT = SUMMARY_BAR_HEIGHT + FAB_BOTTOM_MARGIN + FAB_DIAMETER;
// The extra breathing room below the last row, past what's strictly needed
// to clear the summary bar/FAB â€” expressed as a fraction of device height,
// not a flat pixel count, so it scales down on shorter screens instead of
// dominating them. Was 0.1 (~10% of device height): on top of
// BOTTOM_OBSTRUCTION_HEIGHT and the list's own trailing gap/padding, that
// added up to a visible gap of ~240-256px on a typical phone, noticeably
// more than needed just to keep the last row clear of the FAB. Trimmed to
// this much smaller ratio â€” still a real, non-zero comfort margin so the
// last row doesn't sit flush against the FAB, but most of the clearance
// now comes from BOTTOM_OBSTRUCTION_HEIGHT (the FAB/bar's real, immovable
// footprint) rather than this discretionary top-up. Don't drop this to 0
// or remove it: some margin here is still what keeps the last row from
// touching the FAB on the smallest supported screens.
const BOTTOM_CLEARANCE_GAP_RATIO = 0.02;

// Below this many rows, a pane's content is too short to ever scroll for
// real â€” tying the hero's collapse to that pane's scroll position just
// means reacting to rubber-band/bounce noise instead of an actual scroll
// gesture, which is what caused the flicker this constant exists to avoid.
const MIN_ITEMS_TO_COLLAPSE_HERO = 7;
// How long the hero/title/description take to ease into the incoming tab's
// collapse state on a tab switch â€” a bit slower than the TabView's own slide,
// which read as too abrupt at a matching ~280ms.
const TAB_SWITCH_HERO_DURATION_MS = 500;
// titleRow's resting paddingTop, before any scroll-driven status-bar
// clearance is added on top (see titleClearanceAnim).
const TITLE_ROW_BASE_PADDING_TOP = 12;

function currencyCountryCode(code: string) {
  return CURRENCIES.find((currency) => currency.code === code)?.countryCode;
}

function AdminBadge({ size }: { size: number }) {
  return (
    <View style={[styles.adminBadge, { width: size, height: size, borderRadius: size / 2 }]}>
      <Ionicons name="shield" size={size * 0.6} color={Colors.accentText} />
    </View>
  );
}

// Shared entrance/exit animation for the detail popups (member + log): the
// backdrop fades while the card scales up from a slight shrink, and reverses
// symmetrically on close. RN's Modal has no exit-animation hook of its own
// (setting visible={false} unmounts immediately), so this keeps the Modal
// mounted through the closing animation via its own `isMounted` state and
// only lets the parent's `isOpen` go false once that animation finishes.
// The optional `onClosed` fires at that same moment â€” real completion of the
// close animation, not a guessed duration â€” so a caller that wants to open a
// second Modal right after this one (see LogsPane's handleSelectMemberFromLog)
// can wait for this Modal to actually finish closing first. That matters
// because RN's Modal is a native presentation on both platforms: opening one
// while another is still mid-dismissal can silently drop the new one on iOS,
// and has been known to leave a dead, untouchable overlay on Android.
function usePopupAnimation(isOpen: boolean, onClosed?: () => void) {
  const [isMounted, setIsMounted] = useState(isOpen);
  const [progress] = useState(() => new Animated.Value(isOpen ? 1 : 0));

  // Always call the latest onClosed without needing it in the animation
  // effect's own dependency array below (which would otherwise restart the
  // in-flight animation whenever the caller passes a new function
  // reference). Updated in its own effect, not during render â€” React
  // forbids writing a ref's `current` outside an effect/event handler.
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  // Mounting has to happen in time for the entrance animation to have
  // something to animate, so it's applied directly during render (React's
  // documented pattern for "adjust state when a prop changes") rather than
  // in the effect below, which only kicks off the imperative Animated calls.
  if (isOpen && !isMounted) {
    setIsMounted(true);
  }

  useEffect(() => {
    if (isOpen) {
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        speed: 18,
        bounciness: 6,
      }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setIsMounted(false);
          onClosedRef.current?.();
        }
      });
    }
  }, [isOpen, progress]);

  return { isMounted, progress };
}

// Everyone a log's cost was actually split across: the "purchase was for"
// checklist, plus the payer themselves when they included their own share.
// `members` excludes the current viewer, so the viewer's own entry (as
// payer or as a beneficiary of someone else's log) is filled in separately,
// using their real name/initials rather than a placeholder â€” this list
// mirrors the Members tab, where everyone is shown by their actual name.
function resolvePurchasedFor(
  log: LogEntry,
  members: GroupMember[],
  currentUserId: string,
  viewerName: string,
  viewerAvatarUrl: string | null,
  viewerIsAdmin: boolean
): GroupMember[] {
  const ids = log.payerIncluded ? [...log.memberIds, log.paidBy] : log.memberIds;
  return ids
    .map((id, index) => {
      // A null id means that person has since deleted their account (see
      // delete_account in schema.sql) â€” the log_members/paid_by row is kept
      // (with the reference nulled out) specifically so shareCount doesn't
      // shrink and silently change everyone else's historical balance; this
      // placeholder just stands in for their erased identity. The index
      // suffix keeps each one's key unique if more than one person in the
      // same split has deleted their account.
      if (id === null) {
        return {
          id: `deleted-${index}`,
          name: "Deleted user",
          avatarUrl: null,
          isActive: false,
          isAdmin: false,
        };
      }
      return id === currentUserId
        ? {
          id,
          name: viewerName,
          avatarUrl: viewerAvatarUrl,
          isActive: true,
          isAdmin: viewerIsAdmin,
        }
        : members.find((member) => member.id === id);
    })
    .filter((member): member is GroupMember => !!member);
}

function resolvePayerName(
  paidBy: string | null,
  members: GroupMember[],
  currentUserId: string
) {
  if (paidBy === null) return "Deleted user";
  if (paidBy === currentUserId) return "You";
  return members.find((member) => member.id === paidBy)?.name ?? "Someone";
}

// The short headline shown in both the Logs list row and the detail popup's
// own header. A settlement gets a fixed generic title here â€” the specifics
// (who settled with whom, for how much) move to formatSettlementDetail
// instead, shown where a regular entry's own details text would go, since
// "You"/other-name substitution and per-entry amounts read better as a full
// sentence in the popup body than crammed into a list-row headline.
// Always uses convertedAmount + the group's own currency, never log.amount/
// log.currency (the originally-entered ones) â€” see formatOriginalCurrencyNote
// for where that original figure still surfaces.
function formatLogHeadline(log: LogEntry, payerName: string, groupCurrency: string) {
  if (log.isSettlement) return "Debt settlement";
  const amount = Math.round(log.convertedAmount * 100) / 100;
  return `${payerName} spent ${amount} ${groupCurrency}`;
}

// The full sentence for a settlement entry's detail popup, shown in place of
// a regular entry's (user-entered) details text â€” settle_debt always stores
// details as '', so there's nothing to conflict with. Ends with "consisting
// of X EUR" rather than the old "(X EUR)" parenthetical now that the amount
// no longer has a headline to sit inside of.
function formatSettlementDetail(
  log: LogEntry,
  payerName: string,
  purchasedFor: GroupMember[],
  groupCurrency: string,
  currentUserId: string
) {
  // resolvePurchasedFor fills the viewer's own entry in with their real name
  // (for the "purchased for" avatar list, where every member is shown by
  // name), but mid-sentence here that should read "with you" the same way
  // payerName already does via resolvePayerName, not "with Alice Tester".
  const counterpart = purchasedFor[0];
  const counterpartName =
    counterpart?.id === currentUserId ? "you" : (counterpart?.name ?? "someone");
  const possessive = payerName === "You" ? "your" : "their";
  const amount = Math.round(log.convertedAmount * 100) / 100;
  return `${payerName} settled ${possessive} debt with ${counterpartName}, consisting of ${amount} ${groupCurrency}.`;
}

// The Logs tab always lists amounts in the group's current currency (see
// formatLogHeadline), so when an entry was originally entered in a different
// one â€” either logged in another currency to begin with, or the group's
// currency changed since (change_group_currency rescales convertedAmount but
// deliberately leaves the original amount/currency alone) â€” this surfaces
// that original figure in the entry's detail popup rather than losing it.
function formatOriginalCurrencyNote(log: LogEntry, groupCurrency: string) {
  if (log.currency === groupCurrency) return null;
  return `This expense was originally logged as ${log.amount} ${log.currency}.`;
}

function formatDebt(debt: number, currency: string) {
  const roundedDebt = Math.round(debt * 100) / 100;
  const isSettled = roundedDebt === 0;
  const isOwed = roundedDebt > 0;
  const amountLabel = `${Math.abs(roundedDebt)}${currency ? ` ${currency}` : ""}`;
  return { isSettled, isOwed, amountLabel };
}

function MemberRow({
  member,
  debt,
  currency,
  onPress,
}: {
  member: GroupMember;
  debt: number;
  currency: string;
  onPress: () => void;
}) {
  const { isSettled, isOwed, amountLabel } = formatDebt(debt, currency);

  return (
    <Pressable style={styles.memberRow} onPress={onPress}>
      <View style={styles.avatarBadgeWrapper}>
        <Avatar
          name={member.name}
          avatarUrl={member.avatarUrl}
          style={[styles.avatar, !member.isActive && styles.avatarInactive]}
          textStyle={styles.avatarText}
        />
        {member.isAdmin ? <AdminBadge size={18} /> : null}
      </View>
      <View style={styles.memberNameColumn}>
        <Text style={[styles.memberName, !member.isActive && styles.memberNameInactive]}>
          {member.name}
        </Text>
        {!member.isActive ? <Text style={styles.leftLabel}>Left group</Text> : null}
      </View>
      <View style={styles.memberDivider} />
      <View style={styles.debtColumn}>
        {isSettled ? (
          <Text style={styles.debtSettled}>Settled up</Text>
        ) : (
          <>
            <Text style={[styles.debtLabel, isOwed ? styles.debtPositive : styles.debtNegative]}>
              {isOwed ? "owes you" : "you owe"}
            </Text>
            <Text style={[styles.debtAmount, isOwed ? styles.debtPositive : styles.debtNegative]}>
              {amountLabel}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

type MemberAction = "promote" | "kick" | "settle";

const MEMBER_MORPH_DURATION_MS = 260;
const MEMBER_ROW_ICON_SIZE = 20;
const MEMBER_ROW_ICON_GAP = 12;
const MEMBER_ROW_PADDING = 16;
const MEMBER_ROW_SPACING = 12;
const MEMBER_TITLE_FONT_SIZE = 16;

// One of MemberDetailOverlay's action rows. Driven by the overlay's shared
// `morph`: the row that was tapped (`chosen`) slides up to the top of the
// rows area, shedding its own frame and icon so its label ends up as the
// confirmation's title, while every other row fades out in place. The row
// keeps its padding, so the title lands inset inside the confirmation's own
// bordered box (memberConfirmDetails), which fades in around it. Nothing collapses — the overlay locks the rows area's height, so the
// popup keeps its exact size and shape throughout. Each worklet reads all its
// shared values up front — on web Reanimated only tracks the ones read on
// every run, not ones behind an early branch.
function MemberActionRow({
  action,
  morph,
  chosen,
  isConfirming,
  isChosen,
  disabled,
  icon,
  label,
  title,
  labelColor,
  onPress,
}: {
  action: MemberAction;
  morph: SharedValue<number>;
  chosen: SharedValue<MemberAction | null>;
  isConfirming: boolean;
  // Whether this is the row the confirmation is (or was last) about.
  isChosen: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  title: string;
  labelColor: string;
  onPress: () => void;
}) {
  // The row's resting offset from the top of the rows area, i.e. how far it
  // has to travel to become the title. Only taken at rest, never mid-morph.
  const restingY = useSharedValue(0);
  const onLayout = (event: LayoutChangeEvent) => {
    if (morph.value === 0) restingY.value = event.nativeEvent.layout.y;
  };

  const wrapperStyle = useAnimatedStyle(() => {
    const m = morph.value;
    const c = chosen.value;
    const y = restingY.value;
    if (c === action) return { opacity: 1, transform: [{ translateY: -y * m }] };
    const amount = 1 - m;
    return { opacity: amount * amount, transform: [{ translateY: 0 }] };
  });
  const frameStyle = useAnimatedStyle(() => {
    const m = chosen.value === action ? morph.value : 0;
    return {
      borderColor: interpolateColor(m, [0, 1], [Colors.border, "rgba(0, 0, 0, 0)"]),
      // Cleared too, or the row's fill would cover the confirmation box's
      // top border and message where it comes to rest over them.
      backgroundColor: interpolateColor(m, [0, 1], [Colors.background, "rgba(0, 0, 0, 0)"]),
    };
  });
  // Gone before the sliding label reaches it.
  const iconStyle = useAnimatedStyle(() => {
    const m = chosen.value === action ? morph.value : 0;
    return { opacity: interpolate(m, [0, 0.3], [1, 0], "clamp") };
  });
  const labelStyle = useAnimatedStyle(() => {
    const m = chosen.value === action ? morph.value : 0;
    return {
      color: interpolateColor(m, [0, 1], [labelColor, Colors.text]),
      fontSize: 15 + m * (MEMBER_TITLE_FONT_SIZE - 15),
      marginLeft: (1 - m) * (MEMBER_ROW_ICON_SIZE + MEMBER_ROW_ICON_GAP),
    };
  });

  return (
    <Reanimated.View
      style={[isChosen && styles.memberActionChosen, wrapperStyle]}
      onLayout={onLayout}
      pointerEvents={isConfirming ? "none" : "auto"}
    >
      <Pressable
        style={disabled && styles.actionRowDisabled}
        onPress={onPress}
        disabled={disabled || isConfirming}
      >
        <Reanimated.View style={[styles.actionRow, styles.memberActionFrame, frameStyle]}>
          <Reanimated.View style={[styles.memberActionIcon, iconStyle]}>{icon}</Reanimated.View>
          <Reanimated.Text
            style={[styles.rowLabel, isConfirming && isChosen && styles.titleText, labelStyle]}
          >
            {isConfirming && isChosen ? title : label}
          </Reanimated.Text>
        </Reanimated.View>
      </Pressable>
    </Reanimated.View>
  );
}

function MemberDetailOverlay({
  member,
  debt,
  currency,
  viewerIsAdmin,
  onClose,
  onSettle,
  onPromote,
  onKick,
}: {
  member: GroupMember | null;
  debt: number;
  currency: string;
  viewerIsAdmin: boolean;
  onClose: () => void;
  onSettle: () => Promise<void>;
  onPromote: () => Promise<void>;
  onKick: () => Promise<void>;
}) {
  const { isMounted, progress } = usePopupAnimation(!!member);
  // Kept in sync only while a member is set, so the popup's content doesn't
  // flash to its "nothing selected" state while it animates closed (Modal
  // stays mounted for that whole animation â€” see usePopupAnimation). Set
  // directly during render (not an effect) per React's documented pattern
  // for adjusting state in response to a prop change.
  const [displayMember, setDisplayMember] = useState(member);
  const [displayDebt, setDisplayDebt] = useState(debt);
  if (member && (member !== displayMember || debt !== displayDebt)) {
    setDisplayMember(member);
    setDisplayDebt(debt);
  }

  const { isSettled, isOwed, amountLabel } = formatDebt(displayDebt, currency);

  // Tapping one of the action rows morphs the rows area in place into a
  // confirmation, like "Leave group" in GroupActionsMenu: the other rows fade
  // out, the tapped row's label slides up into the title, and the warning
  // and Cancel / confirm buttons fade in below it. The avatar, name and debt
  // above stay untouched, and the popup keeps its exact size.
  // `confirmAction` is the row last tapped and outlives Cancel until the
  // morph back out has finished, so that still knows which row to animate;
  // `isConfirming` is whether the confirmation is actually showing.
  const [confirmAction, setConfirmAction] = useState<MemberAction | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  // A fresh open always starts on the plain detail view, even if the popup
  // was last closed mid-confirmation — snapping straight there (`snapBack`)
  // rather than visibly animating out of the leftover confirmation. Same
  // set-during-render pattern as above.
  const [snapBack, setSnapBack] = useState(false);
  const isOpen = !!member;
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setIsConfirming(false);
      setIsBusy(false);
      setSnapBack(true);
    }
  }

  const morph = useSharedValue(0);
  const chosen = useSharedValue<MemberAction | null>(null);
  useEffect(() => {
    morph.value =
      !isConfirming && snapBack
        ? 0
        : withTiming(isConfirming ? 1 : 0, { duration: MEMBER_MORPH_DURATION_MS });
  }, [isConfirming, snapBack, morph]);
  // Once the morph back out has finished, drop the confirmation layer
  // entirely rather than leaving it invisible over the rows: on web, text
  // inside it keeps `pointer-events: auto` even under a `pointerEvents="none"`
  // parent, so a hidden layer would still swallow taps meant for the rows.
  useEffect(() => {
    if (isConfirming) return;
    const timeout = setTimeout(() => setConfirmAction(null), MEMBER_MORPH_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [isConfirming]);

  // The rows area is locked to its resting height for the whole morph, so
  // the popup never changes size: the confirmation plays out entirely inside
  // the space the three rows took up. Measured only at rest (height "auto"),
  // never while locked.
  const rowsHeight = useSharedValue(0);
  const onRowsLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (morph.value === 0 && height > 0) rowsHeight.value = height;
  };
  const rowsAreaStyle = useAnimatedStyle(() => {
    const m = morph.value;
    const h = rowsHeight.value;
    return { height: m === 0 ? "auto" : h };
  });
  // Fades in behind the sliding title, once the other rows are mostly gone.
  const detailsStyle = useAnimatedStyle(() => {
    const amount = interpolate(morph.value, [0.4, 1], [0, 1], "clamp");
    return { opacity: amount * amount };
  });

  const startConfirm = (action: MemberAction) => {
    chosen.value = action;
    setConfirmAction(action);
    setIsConfirming(true);
    setSnapBack(false);
  };

  const handleConfirm = async () => {
    if (!confirmAction) return;
    const run = { promote: onPromote, kick: onKick, settle: onSettle }[confirmAction];
    setIsBusy(true);
    // On success the parent closes the popup; on failure it reports the
    // error and the confirmation stays up so it can be retried or cancelled.
    await run();
    setIsBusy(false);
  };

  const targetIsAdmin = displayMember?.isAdmin ?? false;
  const targetIsActive = displayMember?.isActive ?? false;
  // Only an admin can promote, only a non-admin can be promoted, and only an
  // active member can be promoted at all â€” any of those failing grays the
  // row out per the product requirement, with the label distinguishing why
  // (a departed member reuses the same "Left group" wording as the Members
  // list, rather than letting the press-and-hold run and fail with an alert).
  const canPromote = viewerIsAdmin && !targetIsAdmin && targetIsActive;
  const promoteLabel = !targetIsActive
    ? "Left group"
    : targetIsAdmin
      ? "Already an admin"
      : "Promote to admin";
  // Kicking someone who's already left doesn't mean anything, so that's
  // grayed out too, not just "you're not an admin".
  const canKick = viewerIsAdmin && targetIsActive;
  // The "Deleted user" placeholder represents one or more erased accounts
  // merged together (see DELETED_USER_ID in balances.ts) â€” there's no real
  // account left to record a settlement against, so this is grayed out
  // regardless of whether its merged balance happens to be zero.
  const targetIsDeleted = displayMember?.id === DELETED_USER_ID;
  const canSettle = !isSettled && !targetIsDeleted;
  const name = displayMember?.name ?? "";

  const confirmation: Record<
    MemberAction,
    { title: string; message: string; confirmLabel: string; destructive?: boolean }
  > = {
    promote: {
      title: `Promote ${name}?`,
      message: "They'll be able to edit the group and promote or remove members. This can't be undone.",
      confirmLabel: "Promote",
    },
    kick: {
      title: `Remove ${name}?`,
      message:
        "They'll be removed from this group. Their existing logs and balances stay visible, and they can rejoin later via an invite link.",
      confirmLabel: "Remove",
      destructive: true,
    },
    settle: {
      title: "Settle debt?",
      message: `This adds a log entry recording that ${isOwed ? `${name} paid you` : `you paid ${name}`} ${amountLabel}.`,
      confirmLabel: "Settle",
    },
  };

  return (
    <Modal transparent visible={isMounted} animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.detailBackdrop, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Animated.View
          style={[
            styles.detailBox,
            {
              opacity: progress,
              transform: [
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.92, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <Pressable onPress={() => { }}>
            {displayMember ? (
              <>
                <View style={styles.memberDetailCloseRow}>
                  <Pressable onPress={onClose} hitSlop={12}>
                    <Ionicons name="close" size={22} color={Colors.text} />
                  </Pressable>
                </View>

                <View style={styles.memberDetailHeader}>
                  <View style={[styles.avatarBadgeWrapper, styles.avatarLargeBadgeWrapper]}>
                    <Avatar
                      name={displayMember.name}
                      avatarUrl={displayMember.avatarUrl}
                      style={[styles.avatarLarge, !displayMember.isActive && styles.avatarInactive]}
                      textStyle={styles.avatarLargeText}
                    />
                    {displayMember.isAdmin ? <AdminBadge size={28} /> : null}
                  </View>
                  <Text style={styles.memberDetailName}>{displayMember.name}</Text>
                  {isSettled ? (
                    <Text style={styles.debtSettled}>Settled up</Text>
                  ) : (
                    <Text
                      style={[
                        styles.memberDetailDebt,
                        isOwed ? styles.debtPositive : styles.debtNegative,
                      ]}
                    >
                      {isOwed ? "Owes you " : "You owe "}
                      {amountLabel}
                    </Text>
                  )}
                </View>

                <Reanimated.View
                  style={[styles.memberDetailRowsList, styles.collapsible, rowsAreaStyle]}
                  onLayout={onRowsLayout}
                >
                  <MemberActionRow
                    action="promote"
                    isChosen={confirmAction === "promote"}
                    morph={morph}
                    chosen={chosen}
                    isConfirming={isConfirming}
                    disabled={!canPromote}
                    icon={<Ionicons name="arrow-up" size={MEMBER_ROW_ICON_SIZE} color={Colors.text} />}
                    label={promoteLabel}
                    title={confirmation.promote.title}
                    labelColor={Colors.text}
                    onPress={() => startConfirm("promote")}
                  />
                  <MemberActionRow
                    action="kick"
                    isChosen={confirmAction === "kick"}
                    morph={morph}
                    chosen={chosen}
                    isConfirming={isConfirming}
                    disabled={!canKick}
                    icon={
                      <Ionicons
                        name="person-remove-outline"
                        size={MEMBER_ROW_ICON_SIZE}
                        color={Colors.danger}
                      />
                    }
                    label="Kick group member"
                    title={confirmation.kick.title}
                    labelColor={Colors.danger}
                    onPress={() => startConfirm("kick")}
                  />
                  <MemberActionRow
                    action="settle"
                    isChosen={confirmAction === "settle"}
                    morph={morph}
                    chosen={chosen}
                    isConfirming={isConfirming}
                    disabled={!canSettle}
                    icon={
                      <MaterialCommunityIcons
                        name="handshake-outline"
                        size={MEMBER_ROW_ICON_SIZE}
                        color={Colors.text}
                      />
                    }
                    label={isSettled ? "You're settled up" : "Settle debt"}
                    title={confirmation.settle.title}
                    labelColor={Colors.text}
                    onPress={() => startConfirm("settle")}
                  />

                  {confirmAction ? (
                    <Reanimated.View
                      style={[styles.memberConfirmDetails, detailsStyle]}
                      pointerEvents={isConfirming ? "box-none" : "none"}
                    >
                      {/* Invisible stand-in for the title the chosen row
                          slides up into, so the message lays out right
                          below it however many lines the title wraps to. */}
                      <Text style={[styles.rowLabel, styles.titleText, styles.memberConfirmTitle]}>
                        {confirmation[confirmAction].title}
                      </Text>
                      <ConfirmationBody
                        message={confirmation[confirmAction].message}
                        confirmLabel={confirmation[confirmAction].confirmLabel}
                        destructive={confirmation[confirmAction].destructive}
                        disabled={isBusy || !isConfirming}
                        messageInset={0}
                        buttonsInset={0}
                        fill
                        onCancel={() => setIsConfirming(false)}
                        onConfirm={handleConfirm}
                      />
                    </Reanimated.View>
                  ) : null}
                </Reanimated.View>
              </>
            ) : null}
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function MembersPane({
  currency,
  members,
  balances,
  onSelectMember,
  onScroll,
  minListHeight,
  footerHeight,
}: {
  currency: string;
  members: GroupMember[];
  balances: Record<string, number>;
  onSelectMember: (member: GroupMember) => void;
  // Left undefined below the row threshold â€” see isMembersCollapsible in
  // GroupDetailScreen for why.
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  minListHeight: number;
  footerHeight: number;
}) {
  // Active members first; members who've left sink to the bottom rather than
  // interrupting the active list.
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => Number(!a.isActive) - Number(!b.isActive)),
    [members]
  );

  if (members.length === 0) {
    return (
      <View style={styles.pane}>
        <Text style={styles.paneText}>No other members yet</Text>
      </View>
    );
  }

  const list = (
    <Animated.FlatList<GroupMember>
      data={sortedMembers}
      keyExtractor={(item) => item.id}
      style={minListHeight > 0 ? styles.flex : undefined}
      contentContainerStyle={[styles.membersList, { minHeight: minListHeight }]}
      onScroll={onScroll}
      scrollEventThrottle={16}
      ListFooterComponent={<View style={{ height: footerHeight }} />}
      renderItem={({ item }) => (
        <MemberRow
          member={item}
          debt={balances[item.id] ?? 0}
          currency={currency}
          onPress={() => onSelectMember(item)}
        />
      )}
    />
  );
  // Wrapped in a definite-height box only for a non-collapsible pane
  // (minListHeight > 0) â€” see nonCollapsibleMinHeight in GroupDetailScreen
  // for why this needs to cap the list's own box, not just its content's
  // minHeight. Left completely unwrapped for a collapsible pane
  // (minListHeight === 0), which already fills the full tab area correctly
  // as the TabView scene's direct child â€” wrapping it here too would swap
  // that for a View whose own sizing isn't guaranteed the same way.
  return minListHeight > 0 ? <View style={{ height: minListHeight }}>{list}</View> : list;
}

function LogRow({
  log,
  members,
  currentUserId,
  viewerName,
  viewerAvatarUrl,
  viewerIsAdmin,
  groupCurrency,
  onPress,
}: {
  log: LogEntry;
  members: GroupMember[];
  currentUserId: string;
  viewerName: string;
  viewerAvatarUrl: string | null;
  viewerIsAdmin: boolean;
  groupCurrency: string;
  onPress: () => void;
}) {
  const purchasedFor = resolvePurchasedFor(
    log,
    members,
    currentUserId,
    viewerName,
    viewerAvatarUrl,
    viewerIsAdmin
  );
  const payerName = resolvePayerName(log.paidBy, members, currentUserId);

  return (
    <Pressable style={styles.logCard} onPress={onPress}>
      <Text style={styles.logAmount}>{formatLogHeadline(log, payerName, groupCurrency)}</Text>
      {log.isPending ? (
        <View style={styles.logPending}>
          <Ionicons name="cloud-upload-outline" size={14} color={Colors.muted} />
          <Text style={styles.logPendingText}>Waiting to sync</Text>
        </View>
      ) : null}
      {purchasedFor.length > 0 ? (
        <View style={styles.logAvatars}>
          {purchasedFor.map((member, index) => (
            <Avatar
              key={member.id}
              name={member.name}
              avatarUrl={member.avatarUrl}
              style={[
                styles.logAvatar,
                index > 0 && styles.logAvatarOverlap,
                !member.isActive && styles.avatarInactive,
              ]}
              textStyle={styles.logAvatarText}
            />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

const LOG_ICON_SIZE = 24;
const LOG_BUTTON_ICON_SIZE = 20;
const LOG_ICON_GAP = 20;
const LOG_BUTTON_GAP = 12;
// Where an icon sits inside a confirmation button: actionRow's 1px border
// plus logConfirmButtonContent's horizontal padding.
const LOG_BUTTON_PADDING_X = 12;
const LOG_BUTTON_INSET = 1 + LOG_BUTTON_PADDING_X;
// "Delete entry" gets the wider share so its label fits on one line in the
// popup at phone widths.
const LOG_CANCEL_FLEX = 2;
const LOG_DELETE_FLEX = 3;
const LOG_MORPH_DURATION_MS = 260;
const LOG_PRESS_DURATION_MS = 180;

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

// The edit/delete icons in the log popup's bottom-right corner. Tapping the
// trash morphs them in place into a Cancel / Delete entry confirmation
// (like GroupActionsMenu's leave confirmation) instead of opening an alert:
// the trash slides left into the Delete entry button and the pencil slides
// into the Cancel button, turning into a close icon on the way, while the
// button frames and labels fade in around them. Cancel morphs back.
function LogEntryActions({
  canEdit,
  onEdit,
  onDelete,
}: {
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);

  // Drives the Delete entry button's fill from outlined to solid red (label
  // and trash icon to white), eased in on press-in rather than snapping. It
  // stays filled for the whole delete, not just while the finger is down, so
  // even a quick tap visibly registers — and the button can't be tapped twice.
  // Only eased back out if the press is cancelled; on confirm the popup
  // closes immediately with it still filled (the delete itself runs
  // optimistically in the background — see handleDelete in LogsPane).
  // (onPressOut fires right before onPress, so the fade-out it starts is
  // replaced by onPress's fade-in within the same tick, before a frame renders.)
  const [isDeleting, setIsDeleting] = useState(false);
  const deletePress = useSharedValue(0);
  const setDeletePressed = (pressed: boolean) => {
    deletePress.value = withTiming(pressed ? 1 : 0, { duration: LOG_PRESS_DURATION_MS });
  };
  const handleDeletePress = () => {
    setIsDeleting(true);
    setDeletePressed(true);
    onDelete();
  };
  const deleteButtonFillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      deletePress.value,
      [0, 1],
      [Colors.background, Colors.danger]
    ),
    borderColor: interpolateColor(deletePress.value, [0, 1], [Colors.border, Colors.danger]),
  }));
  const deleteLabelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(deletePress.value, [0, 1], [Colors.danger, Colors.accentText]),
  }));
  // The trash icon lives in the sliding layer above the button, so its white
  // version is crossfaded in on top of the red one instead.
  const trashWhiteGlyphStyle = useAnimatedStyle(() => ({ opacity: deletePress.value }));
  const morph = useSharedValue(0);
  useEffect(() => {
    morph.value = withTiming(isConfirming ? 1 : 0, { duration: LOG_MORPH_DURATION_MS });
  }, [isConfirming, morph]);

  // The sliding icons are absolutely positioned, so their start/end points
  // are computed from the row's measured width and the buttons' measured
  // height. The buttons layer is absolutely positioned too, so measuring it
  // is never affected by the container height it drives.
  const width = useSharedValue(0);
  const buttonHeight = useSharedValue(0);
  const onContainerLayout = (event: LayoutChangeEvent) => {
    width.value = event.nativeEvent.layout.width;
  };
  const onButtonsLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) buttonHeight.value = height;
  };

  const containerStyle = useAnimatedStyle(() => ({
    height:
      LOG_ICON_SIZE + morph.value * (Math.max(buttonHeight.value, LOG_ICON_SIZE) - LOG_ICON_SIZE),
  }));
  const buttonsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(morph.value, [0.35, 1], [0, 1], "clamp"),
  }));

  // Each icon's center moves from its spot in the icon row to its spot at the
  // start of a button, shrinking to the buttons' icon size on the way. The
  // math is repeated inline in each style rather than shared via a helper
  // worklet, since on web Reanimated only tracks shared values read directly
  // in the useAnimatedStyle callback — reads inside a nested function never
  // trigger an update.
  const trashStyle = useAnimatedStyle(() => {
    const m = morph.value;
    const deleteButtonLeft =
      ((width.value - LOG_BUTTON_GAP) * LOG_CANCEL_FLEX) / (LOG_CANCEL_FLEX + LOG_DELETE_FLEX) +
      LOG_BUTTON_GAP;
    const fromX = width.value - LOG_ICON_SIZE / 2;
    const toX = deleteButtonLeft + LOG_BUTTON_INSET + LOG_BUTTON_ICON_SIZE / 2;
    const toY = buttonHeight.value / 2;
    return {
      opacity: width.value > 0 ? 1 : 0,
      transform: [
        { translateX: fromX + m * (toX - fromX) - LOG_ICON_SIZE / 2 },
        { translateY: m * (toY - LOG_ICON_SIZE / 2) },
        { scale: 1 + m * (LOG_BUTTON_ICON_SIZE / LOG_ICON_SIZE - 1) },
      ],
    };
  });
  const pencilStyle = useAnimatedStyle(() => {
    const m = morph.value;
    const fromX = width.value - LOG_ICON_SIZE - LOG_ICON_GAP - LOG_ICON_SIZE / 2;
    const toX = LOG_BUTTON_INSET + LOG_BUTTON_ICON_SIZE / 2;
    const toY = buttonHeight.value / 2;
    return {
      opacity: width.value > 0 ? 1 : 0,
      transform: [
        { translateX: fromX + m * (toX - fromX) - LOG_ICON_SIZE / 2 },
        { translateY: m * (toY - LOG_ICON_SIZE / 2) },
        { scale: 1 + m * (LOG_BUTTON_ICON_SIZE / LOG_ICON_SIZE - 1) },
      ],
    };
  });
  const pencilGlyphStyle = useAnimatedStyle(() => ({
    opacity: interpolate(morph.value, [0, 0.5], [1, 0], "clamp"),
  }));
  const closeGlyphStyle = useAnimatedStyle(() => ({
    opacity: interpolate(morph.value, [0.5, 1], [0, 1], "clamp"),
  }));

  return (
    <Reanimated.View style={[styles.logActions, containerStyle]} onLayout={onContainerLayout}>
      <Reanimated.View
        style={[styles.logConfirmButtons, buttonsStyle]}
        onLayout={onButtonsLayout}
        pointerEvents={isConfirming ? "auto" : "none"}
      >
        <Pressable
          style={[styles.actionRow, { flex: LOG_CANCEL_FLEX }]}
          onPress={() => setIsConfirming(false)}
        >
          <View style={styles.logConfirmButtonContent}>
            {/* Slot for the sliding pencil/close icon; with no edit icon to
                slide in (settlements), the close icon just fades in here. */}
            <View style={styles.logButtonIconSlot}>
              {canEdit ? null : (
                <Ionicons name="close-outline" size={LOG_BUTTON_ICON_SIZE} color={Colors.text} />
              )}
            </View>
            <Text style={styles.rowLabel} numberOfLines={1}>
              Cancel
            </Text>
          </View>
        </Pressable>
        <AnimatedPressable
          style={[styles.actionRow, { flex: LOG_DELETE_FLEX }, deleteButtonFillStyle]}
          onPressIn={() => setDeletePressed(true)}
          onPressOut={() => setDeletePressed(false)}
          onPress={handleDeletePress}
          disabled={isDeleting}
        >
          <View style={styles.logConfirmButtonContent}>
            <View style={styles.logButtonIconSlot} />
            <Reanimated.Text style={[styles.rowLabel, deleteLabelStyle]} numberOfLines={1}>
              Delete entry
            </Reanimated.Text>
          </View>
        </AnimatedPressable>
      </Reanimated.View>

      {canEdit ? (
        <Reanimated.View
          style={[styles.logSlidingIcon, pencilStyle]}
          pointerEvents={isConfirming ? "none" : "auto"}
        >
          <Pressable
            onPress={onEdit}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Edit entry"
          >
            <Reanimated.View style={pencilGlyphStyle}>
              <Ionicons name="create-outline" size={LOG_ICON_SIZE} color={Colors.text} />
            </Reanimated.View>
            <Reanimated.View style={[StyleSheet.absoluteFill, closeGlyphStyle]}>
              <Ionicons name="close-outline" size={LOG_ICON_SIZE} color={Colors.text} />
            </Reanimated.View>
          </Pressable>
        </Reanimated.View>
      ) : null}
      <Reanimated.View
        style={[styles.logSlidingIcon, trashStyle]}
        pointerEvents={isConfirming ? "none" : "auto"}
      >
        <Pressable
          onPress={() => setIsConfirming(true)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Delete entry"
        >
          <Ionicons name="trash-outline" size={LOG_ICON_SIZE} color={Colors.danger} />
          <Reanimated.View style={[StyleSheet.absoluteFill, trashWhiteGlyphStyle]}>
            <Ionicons name="trash-outline" size={LOG_ICON_SIZE} color={Colors.accentText} />
          </Reanimated.View>
        </Pressable>
      </Reanimated.View>
    </Reanimated.View>
  );
}

function LogDetailOverlay({
  log,
  members,
  currentUserId,
  viewerName,
  viewerAvatarUrl,
  viewerIsAdmin,
  groupCurrency,
  onClose,
  onDelete,
  onEdit,
  onSelectMember,
  onFullyClosed,
}: {
  log: LogEntry | null;
  members: GroupMember[];
  currentUserId: string;
  viewerName: string;
  viewerAvatarUrl: string | null;
  viewerIsAdmin: boolean;
  groupCurrency: string;
  onClose: () => void;
  onDelete: (log: LogEntry) => void;
  onEdit: (log: LogEntry) => void;
  onSelectMember: (member: GroupMember) => void;
  onFullyClosed: () => void;
}) {
  const { isMounted, progress } = usePopupAnimation(!!log, onFullyClosed);
  // Kept in sync only while a log is set, so the popup's content doesn't
  // flash to its "nothing selected" state while it animates closed. Set
  // directly during render (not an effect) per React's documented pattern
  // for adjusting state in response to a prop change.
  const [displayLog, setDisplayLog] = useState(log);
  if (log && log !== displayLog) {
    setDisplayLog(log);
  }
  // Bumped each time the popup opens (even onto the same log object as last
  // time), to reset LogEntryActions' confirmation state via its key.
  const [prevLog, setPrevLog] = useState(log);
  const [openCount, setOpenCount] = useState(0);
  if (log !== prevLog) {
    setPrevLog(log);
    if (log) setOpenCount((count) => count + 1);
  }

  const purchasedFor = displayLog
    ? resolvePurchasedFor(
      displayLog,
      members,
      currentUserId,
      viewerName,
      viewerAvatarUrl,
      viewerIsAdmin
    )
    : [];
  const payerName = displayLog ? resolvePayerName(displayLog.paidBy, members, currentUserId) : "";
  // A settlement's own `details` is always '' (settle_debt never sets it),
  // so there's nothing to conflict with here â€” this fills the same slot a
  // regular entry's user-entered details text would occupy.
  const detailsText = displayLog?.isSettlement
    ? formatSettlementDetail(displayLog, payerName, purchasedFor, groupCurrency, currentUserId)
    : displayLog?.details || null;

  return (
    <Modal transparent visible={isMounted} animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.detailBackdrop, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Animated.View
          style={[
            styles.detailBox,
            {
              opacity: progress,
              transform: [
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.92, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <Pressable onPress={() => { }}>
            {displayLog ? (
              <>
                <View style={styles.detailHeader}>
                  <Text style={[styles.logDetailTitle, styles.detailHeaderText]}>
                    {formatLogHeadline(displayLog, payerName, groupCurrency)}
                  </Text>
                  <Pressable onPress={onClose} hitSlop={12}>
                    <Ionicons name="close" size={22} color={Colors.text} />
                  </Pressable>
                </View>

                {detailsText ? (
                  <Text style={styles.logDetailDescription}>{detailsText}</Text>
                ) : null}

                {formatOriginalCurrencyNote(displayLog, groupCurrency) ? (
                  <Text style={styles.originalCurrencyNote}>
                    {formatOriginalCurrencyNote(displayLog, groupCurrency)}
                  </Text>
                ) : null}

                <View style={styles.detailMembersList}>
                  {purchasedFor.map((member) => {
                    const content = (
                      <>
                        <View style={styles.avatarBadgeWrapper}>
                          <Avatar
                            name={member.name}
                            avatarUrl={member.avatarUrl}
                            style={[styles.avatar, !member.isActive && styles.avatarInactive]}
                            textStyle={styles.avatarText}
                          />
                          {member.isAdmin ? <AdminBadge size={18} /> : null}
                        </View>
                        <Text style={styles.memberName}>{member.name}</Text>
                      </>
                    );

                    // Tapping yourself doesn't lead anywhere â€” the member detail
                    // popup's settle/promote/kick actions all assume a target
                    // other than the viewer. Same for a "Deleted user"
                    // placeholder (see resolvePurchasedFor) â€” there's no real
                    // account behind it to open a popup for.
                    if (member.id === currentUserId || member.id.startsWith("deleted-")) {
                      return (
                        <View key={member.id} style={styles.detailMemberRow}>
                          {content}
                        </View>
                      );
                    }

                    return (
                      <Pressable
                        key={member.id}
                        style={styles.detailMemberRow}
                        onPress={() => onSelectMember(member)}
                      >
                        {content}
                      </Pressable>
                    );
                  })}
                </View>

                {displayLog.paidBy === currentUserId ? (
                  <LogEntryActions
                    // Remounted on every fresh open, so a delete confirmation
                    // left half-open last time doesn't carry over.
                    key={openCount}
                    // Settlements don't go through the regular expense edit
                    // form (update_log excludes them â€” see schema.sql), so
                    // only delete makes sense for them.
                    canEdit={!displayLog.isSettlement}
                    onEdit={() => onEdit(displayLog)}
                    onDelete={() => onDelete(displayLog)}
                  />
                ) : null}
              </>
            ) : null}
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function LogsPane({
  groupId,
  members,
  currentUserId,
  viewerName,
  viewerAvatarUrl,
  viewerIsAdmin,
  groupCurrency,
  onSelectMember,
  onScroll,
  minListHeight,
  footerHeight,
}: {
  groupId: string;
  members: GroupMember[];
  currentUserId: string;
  viewerName: string;
  viewerAvatarUrl: string | null;
  viewerIsAdmin: boolean;
  groupCurrency: string;
  onSelectMember: (member: GroupMember) => void;
  // Left undefined below the row threshold â€” see isLogsCollapsible in
  // GroupDetailScreen for why.
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  minListHeight: number;
  footerHeight: number;
}) {
  const { logs, deleteLog } = useLogs();
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const groupLogs = logs
    .filter((log) => log.groupId === groupId)
    .sort((a, b) => b.createdAt - a.createdAt);

  // Closes the log popup before handing off to the member popup, rather than
  // stacking two modals, so the member detail screen (settle/promote/kick)
  // opens the same way it does from the Members tab. The member doesn't get
  // opened here directly â€” it's stashed and only opened once the log
  // popup's Modal has actually finished closing (see onFullyClosed below).
  // RN's Modal is a native full-screen presentation on both platforms:
  // opening a second one before the first has genuinely finished dismissing
  // can silently drop the new one on iOS, and has been known to leave a
  // dead, untouchable overlay on Android â€” a fixed-duration setTimeout guess
  // isn't reliable here since a slower device can take longer than the
  // animation's nominal duration to actually finish.
  const pendingMemberRef = useRef<GroupMember | null>(null);
  const handleSelectMemberFromLog = (member: GroupMember) => {
    pendingMemberRef.current = member;
    setSelectedLog(null);
  };
  const handleLogPopupFullyClosed = () => {
    const member = pendingMemberRef.current;
    if (!member) return;
    pendingMemberRef.current = null;
    onSelectMember(member);
  };

  const handleEdit = (log: LogEntry) => {
    setSelectedLog(null);
    router.push({ pathname: "/add-entry", params: { groupId, logId: log.id } });
  };

  // Only reached once the user confirms in LogEntryActions' own in-place
  // Cancel / Delete entry confirmation, so no confirm alert here. The popup
  // closes straight away and deleteLog removes the entry optimistically; if
  // the server rejects it, deleteLog puts the entry back and we alert.
  const handleDelete = async (log: LogEntry) => {
    setSelectedLog(null);
    const { error } = await deleteLog(log.id);
    if (error) Alert.alert("Couldn't delete entry", `${error}\n\nPlease try again.`);
  };

  if (groupLogs.length === 0) {
    return (
      <View style={styles.pane}>
        <Text style={styles.paneText}>No entries yet</Text>
      </View>
    );
  }

  const list = (
    <Animated.FlatList<LogEntry>
      data={groupLogs}
      keyExtractor={(item) => item.id}
      style={minListHeight > 0 ? styles.flex : undefined}
      contentContainerStyle={[styles.membersList, { minHeight: minListHeight }]}
      onScroll={onScroll}
      scrollEventThrottle={16}
      ListFooterComponent={<View style={{ height: footerHeight }} />}
      renderItem={({ item }) => (
        <LogRow
          log={item}
          members={members}
          currentUserId={currentUserId}
          viewerName={viewerName}
          viewerAvatarUrl={viewerAvatarUrl}
          viewerIsAdmin={viewerIsAdmin}
          groupCurrency={groupCurrency}
          onPress={() => setSelectedLog(item)}
        />
      )}
    />
  );

  return (
    <>
      {/* See the matching wrapping in MembersPane for why a non-collapsible
          pane (minListHeight > 0) gets its list wrapped in a definite-height
          box instead of just capping the content's minHeight. */}
      {minListHeight > 0 ? <View style={{ height: minListHeight }}>{list}</View> : list}
      <LogDetailOverlay
        log={selectedLog}
        members={members}
        currentUserId={currentUserId}
        viewerName={viewerName}
        viewerAvatarUrl={viewerAvatarUrl}
        viewerIsAdmin={viewerIsAdmin}
        groupCurrency={groupCurrency}
        onClose={() => setSelectedLog(null)}
        onDelete={handleDelete}
        onEdit={handleEdit}
        onSelectMember={handleSelectMemberFromLog}
        onFullyClosed={handleLogPopupFullyClosed}
      />
    </>
  );
}

const SEGMENT_PILL_WINDUP_INSET = 5;

// Members/Logs switcher. The gray highlight is one shared pill that slides
// (and resizes, since the labels differ in width) between the measured
// buttons instead of each button toggling its own background. JS-driven
// because `left`/`width` aren't supported by the native animation driver.
function SegmentTabBar({
  routes,
  index,
  onSelect,
}: {
  routes: TabRoute[];
  index: number;
  onSelect: (index: number) => void;
}) {
  const [layouts, setLayouts] = useState<{ x: number; width: number }[]>([]);
  const [progress] = useState(() => new Animated.Value(index));
  // 0 â†’ 1 pulls both ends of the pill inward by SEGMENT_PILL_WINDUP_INSET,
  // the brief "charge up" before it springs over to the new tab.
  const [windup] = useState(() => new Animated.Value(0));
  const lastIndexRef = useRef(index);
  // Which label the pill is currently over, as opposed to `index` (the tab
  // that was tapped) â€” so the bold weight follows the pill, not the tap.
  const [pillIndex, setPillIndex] = useState(index);
  const isMeasured = routes.every((_, i) => layouts[i] != null);

  useEffect(() => {
    const id = progress.addListener(({ value }) => setPillIndex(Math.round(value)));
    return () => progress.removeListener(id);
  }, [progress]);

  useEffect(() => {
    // Skip the initial mount â€” nothing to jump to yet.
    if (lastIndexRef.current === index) return;
    lastIndexRef.current = index;

    const animation = Animated.sequence([
      Animated.timing(windup, {
        toValue: 1,
        duration: 90,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }),
      Animated.parallel([
        Animated.spring(progress, {
          toValue: index,
          useNativeDriver: false,
          bounciness: 4,
          speed: 16,
        }),
        Animated.spring(windup, {
          toValue: 0,
          useNativeDriver: false,
          bounciness: 8,
          speed: 20,
        }),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [index, progress, windup]);

  const handleLayout = (i: number) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setLayouts((prev) => {
      if (prev[i]?.x === x && prev[i]?.width === width) return prev;
      const next = [...prev];
      next[i] = { x, width };
      return next;
    });
  };

  const inputRange = routes.map((_, i) => i);
  const windupInset = windup.interpolate({
    inputRange: [0, 1],
    outputRange: [0, SEGMENT_PILL_WINDUP_INSET],
  });
  const pillStyle = isMeasured
    ? {
        left: Animated.add(
          progress.interpolate({ inputRange, outputRange: layouts.map((l) => l.x) }),
          windupInset
        ),
        width: Animated.subtract(
          progress.interpolate({ inputRange, outputRange: layouts.map((l) => l.width) }),
          Animated.multiply(windupInset, 2)
        ),
      }
    : null;

  return (
    <View style={styles.segmentRow}>
      <View style={styles.segmentTrack}>
        {pillStyle && (
          <Animated.View pointerEvents="none" style={[styles.segmentPill, pillStyle]} />
        )}
        {routes.map((route, i) => {
          // Label color tracks the pill's position rather than `index`, so a
          // label only fades to muted once the pill actually leaves it (after
          // the wind-up) and darkens as the pill arrives.
          const color = progress.interpolate({
            inputRange: [i - 1, i, i + 1],
            outputRange: [Colors.muted, Colors.text, Colors.muted],
            extrapolate: "clamp",
          });
          return (
            <Pressable
              key={route.key}
              onPress={() => onSelect(i)}
              onLayout={handleLayout(i)}
              style={styles.segmentItem}
            >
              <Animated.Text
                style={[
                  styles.segmentText,
                  i === pillIndex && styles.segmentTextActive,
                  { color },
                ]}
              >
                {route.title}
              </Animated.Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// A transparent -> background gradient pinned to the bottom of the clipped
// description box. Without it the overflow:hidden edge is razor sharp, so
// while the box grows/shrinks each line gets wiped in/out top-to-bottom and
// it reads as text being printed line by line. With the soft edge riding
// along, lines fade in/out as the edge passes them instead. Also doubles as
// the usual "there's more" hint while collapsed. Its opacity is driven by
// toggleDescription (see descriptionFadeAnim). Drawn with react-native-svg
// since expo-linear-gradient isn't a dependency.
function DescriptionFade({ opacity }: { opacity: Animated.Value }) {
  return (
    <Animated.View pointerEvents="none" style={[styles.descriptionFade, { opacity }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <SvgLinearGradient id="descriptionFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={Colors.background} stopOpacity={0} />
            <Stop offset="1" stopColor={Colors.background} stopOpacity={1} />
          </SvgLinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#descriptionFade)" />
      </Svg>
    </Animated.View>
  );
}

// The hero's back chevron â€” same grow + darken press feedback as the
// camera/palette HeroButton in new-group.tsx (scale 1 -> 1.12, tint
// 0.35 -> 0.55). The tint is its own layer so its opacity can animate
// without also fading the chevron, and Pressable only owns hit-testing and
// position so the tap target's size stays stable regardless of the scale.
function HeroBackButton({ style, onPress }: { style: StyleProp<ViewStyle>; onPress: () => void }) {
  const [pressAnim] = useState(() => new Animated.Value(0));
  const animateTo = (toValue: number) => {
    Animated.timing(pressAnim, {
      toValue,
      duration: toValue ? 100 : 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };
  const tintOpacity = pressAnim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.55] });
  const scale = pressAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  return (
    <Pressable
      style={style}
      onPress={onPress}
      onPressIn={() => animateTo(1)}
      onPressOut={() => animateTo(0)}
      hitSlop={12}
    >
      <Animated.View style={[styles.heroBackButtonCircle, { transform: [{ scale }] }]}>
        <Animated.View style={[styles.heroBackButtonTint, { opacity: tintOpacity }]} />
        <Ionicons name="chevron-back" size={22} color={Colors.text} />
      </Animated.View>
    </Pressable>
  );
}

export default function GroupDetailScreen() {
  // `invite` is set when arriving straight from onboarding with the group it
  // just created (see use-onboarding.tsx).
  const { id, invite } = useLocalSearchParams<{ id: string; invite?: string }>();
  const navigation = useNavigation<StackScreenNavigation>();
  const { session } = useAuth();
  const { profile } = useProfile();
  const { groups, removeGroup, promoteToAdmin, kickMember } = useGroups();
  const group = groups.find((item) => item.id === id);
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const heroHeight = windowHeight * HERO_HEIGHT_RATIO;
  // A short list (few members/logs) can end up with less content height
  // than its own visible viewport, which makes it not genuinely scrollable
  // â€” on a real device that shows up as janky, flickery rubber-band/bounce
  // scroll deltas feeding straight into the hero/title transform above,
  // since those are driven directly off raw scroll position. Forcing the
  // content container to be at least as tall as its own real viewport plus
  // a bit extra fixes that â€” measured via onLayout rather than guessed,
  // since the viewport itself already varies with insets/hero size in ways
  // not worth re-deriving here. Falls back to the full window height until
  // the first layout pass lands, so there's no flash of the old
  // (too-short-to-scroll) behavior before that.
  //
  // That "bit extra" has two parts, both required: heroHeight, since
  // scrollY needs to actually reach heroHeight for the collapse animation
  // above to reach its fully-collapsed end (any less and the hero can
  // never fully disappear, no matter how far the list scrolls) â€” plus the
  // summary bar's own height, so the last row can still clear it once
  // fully scrolled.
  const [tabViewHeight, setTabViewHeight] = useState(0);
  const handleTabViewLayout = (event: LayoutChangeEvent) => {
    setTabViewHeight(event.nativeEvent.layout.height);
  };
  // Just the "genuinely scrollable at all" guarantee (see the flicker this
  // was built to prevent) â€” a floor on total content height, nothing more.
  // Deliberately NOT where the bottom-bar/FAB clearance lives anymore: a
  // floor has no effect once real content already exceeds it (which a
  // normal-length list does easily), silently dropping whatever margin was
  // baked into the floor's formula. Clearance instead comes from
  // listFooterHeight below, an actual spacer appended after the last row,
  // which stays in effect unconditionally regardless of content length.
  //
  // Only meaningful for a non-collapsible pane (see nonCollapsibleMinHeight
  // usage below) â€” applying this same viewport-sized floor to a collapsible
  // (>= MIN_ITEMS_TO_COLLAPSE_HERO row) pane too was actively harmful: if
  // that pane's real content + footer happened to add up to less than a
  // full viewport, the floor padded out the *entire remaining difference*
  // as literal blank space below the last row â€” which is how "half the
  // screen" of dead space happened. A collapsible-by-count list is already
  // long enough that it doesn't need this floor for genuine scrollability.
  //
  // Subtracts heroHeight because a non-collapsible pane's hero never slides
  // away (scrollGate stays shut for it â€” see below), so contentLayer sits
  // permanently offset by heroHeight and only (tabViewHeight - heroHeight)
  // of it is ever painted inside the actual screen â€” the remaining
  // heroHeight at the bottom of tabViewHeight is real layout space that
  // exists below the visible viewport and can never be scrolled into view.
  // Sizing the pane off the full tabViewHeight (as before) let its FlatList
  // believe it had that much real viewport to work with, so a pane whose
  // rows fell just short of MIN_ITEMS_TO_COLLAPSE_HERO but still added up
  // to close to a screenful â€” enough to push the trailing footerHeight
  // spacer past the true (smaller) visible height â€” would stop scrolling
  // heroHeight short of its real end, permanently hiding that spacer (and
  // the last row's intended clearance) behind the summary bar/FAB with no
  // way to scroll it into view. Applied below as this pane's own explicit
  // height (see MembersPane/LogsPane's `style`), not just its content's
  // minHeight, so the FlatList's internal scroll viewport matches what's
  // actually on screen and its true end is always reachable.
  const nonCollapsibleMinHeight = Math.max(0, (tabViewHeight || windowHeight) - heroHeight);
  // One footer height for both collapsible and non-collapsible panes â€” the
  // real bottom-bar/FAB clearance (BOTTOM_OBSTRUCTION_HEIGHT) plus a small
  // gap sized off the actual device height (BOTTOM_CLEARANCE_GAP_RATIO),
  // not a flat pixel value â€” a flat value either undershoots on a tall
  // device or, as a large one did here, dominates a short one. A
  // collapsible (>= MIN_ITEMS_TO_COLLAPSE_HERO row) pane used to also bake
  // heroHeight's worth of extra into this same trailing footer, on the
  // theory that it needed that much guaranteed scroll *distance* to ever
  // reach fully-collapsed. But that distance is needed early in the
  // scroll, to let the collapse animation finish â€” a real multi-row list's
  // own natural content is already comfortably taller than a viewport
  // (that's what makes it collapsible in the first place), so it doesn't
  // need extra reserved *at the very end* too; baking it into the
  // permanent trailing footer just left dead space sitting below the last
  // row forever, long after the collapse had already finished.
  const listFooterHeight =
    BOTTOM_OBSTRUCTION_HEIGHT + insets.bottom + windowHeight * BOTTOM_CLEARANCE_GAP_RATIO;
  // Shared by both tabs' lists (see MembersPane/LogsPane's onScroll) so
  // scrolling either one collapses the same hero â€” only one tab is ever
  // actually being scrolled by the user at a time, so this doesn't need
  // per-tab bookkeeping. useNativeDriver keeps the hero/title transform
  // animation on the UI thread, independent of JS frame drops.
  const [scrollY] = useState(() => new Animated.Value(0));
  // Not wiring onScroll for a below-threshold pane (see isMembersCollapsible/
  // isLogsCollapsible below) is meant to be the whole story, but in practice
  // a determined repeated max-distance scroll on a short list can still let
  // some real offset reach scrollY (native rubber-band/overscroll behavior
  // isn't fully suppressed just by leaving a JS prop undefined). Rather than
  // trust that scrollY itself always stays exactly 0 for a non-collapsible
  // pane, the hero's transforms are driven off scrollY multiplied by this
  // 0/1 gate instead â€” multiplying by 0 forces the output to 0 no matter
  // what scrollY actually holds, which is a real guarantee, not a hope.
  const [scrollGate] = useState(() => new Animated.Value(1));
  // Stable across renders (like scrollY/scrollGate above) so the listener
  // effect below isn't tearing down and re-adding its listener every render.
  const [gatedScrollY] = useState(() => Animated.multiply(scrollY, scrollGate));
  const heroTranslateY = gatedScrollY.interpolate({
    inputRange: [0, heroHeight],
    outputRange: [0, -heroHeight],
    extrapolate: "clamp",
  });
  const contentTranslateY = gatedScrollY.interpolate({
    inputRange: [0, heroHeight],
    outputRange: [heroHeight, 0],
    extrapolate: "clamp",
  });
  // The title row needs real insets.top clearance so its text doesn't land
  // under the status bar/notch once fully collapsed and pinned â€” but that
  // same clearance is dead space at rest, when the title is sitting well
  // below the hero already (see the previous white-gap fix). paddingTop
  // can't ride the native-driven transform above (padding isn't
  // transform/opacity, so it can't be natively animated), hence this
  // JS-side value deriving a plain 0..insets.top value from the same
  // scroll offset instead â€” a small, deliberately rounded-to-the-pixel
  // re-render cost during scroll, not a 60fps-critical animation.
  //
  // This used to be a gatedScrollY.addListener() effect, but a JS listener
  // attached to a *derived* native-driven node (gatedScrollY is an
  // Animated.multiply -> interpolate chain fed by a useNativeDriver: true
  // event) is not reliable â€” on-device it never fired at all, even though
  // the native-driven transforms elsewhere read the exact same node and
  // animated correctly. Animated.event's own `listener` option is the
  // documented way to get a JS-thread callback alongside a native-driven
  // event: it runs off the same onScroll dispatch (rate-limited by
  // scrollEventThrottle) rather than depending on the native bridge to
  // sync a composed node's value back down, so it doesn't share that
  // failure mode.
  // handleTitleClearanceScroll doesn't need the scrollGate multiply that
  // gatedScrollY (above) uses to guard the native-driven transforms: it
  // only ever runs off a pane's own onScroll, which itself is left
  // undefined below the collapsible threshold (see isMembersCollapsible/
  // isLogsCollapsible usage further down), so a non-collapsible pane can't
  // drive it at all.
  //
  // Both this and paneScrollOffsets are tracked per tab: each pane's
  // FlatList keeps its own scroll position across tab switches, but scrollY
  // is shared, so on its own it would still hold the *previous* tab's offset
  // after a switch â€” e.g. leaving an expanded Members list for a Logs list
  // that's still scrolled down showed the hero expanded over it. The tab-
  // change effect below restores scrollY from the incoming pane's last
  // recorded offset instead.
  //
  // The clearance itself is a JS-driven Animated.Value rather than state:
  // scrolling just setValue()s it (no re-render per step), and a tab switch
  // can ease it alongside the hero instead of snapping (see the tab-change
  // effect below). It has to be its own non-native value â€” paddingTop can't
  // ride the native driver the way scrollY's transforms do.
  const [titleClearanceAnim] = useState(() => new Animated.Value(0));
  const [titlePaddingTop] = useState(() =>
    Animated.add(new Animated.Value(TITLE_ROW_BASE_PADDING_TOP), titleClearanceAnim)
  );
  const titleClearanceForOffset = (offsetY: number) =>
    Math.round(Math.min(1, Math.max(0, offsetY / heroHeight)) * insets.top);
  // A plain mutable Map held stable via useState (like scrollY above) rather
  // than a ref: it's only ever written from scroll listeners and read from
  // the tab-change effect, never during render.
  const [paneScrollOffsets] = useState(() => new Map<TabRoute["key"], number>());
  const handleTitleClearanceScroll = (
    key: TabRoute["key"],
    event: { nativeEvent: { contentOffset: { y: number } } }
  ) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    paneScrollOffsets.set(key, offsetY);
    titleClearanceAnim.setValue(titleClearanceForOffset(offsetY));
  };
  const handleMembersScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      listener: (event: NativeSyntheticEvent<NativeScrollEvent>) =>
        handleTitleClearanceScroll("members", event),
    }
  );
  const handleLogsScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      listener: (event: NativeSyntheticEvent<NativeScrollEvent>) =>
        handleTitleClearanceScroll("logs", event),
    }
  );
  const [tabIndex, setTabIndex] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  // Set by handleInvite, consumed by handleMenuClosed.
  const pendingInviteRef = useRef(false);
  // Opens the invite share sheet for a group fresh out of onboarding, once
  // this screen has finished sliding in rather than on mount, so the sheet
  // isn't presented over a screen still mid-transition. The param is
  // cleared first so it can't fire again (e.g. on a web reload).
  const groupIdToInvite = invite === "1" ? group?.id : undefined;
  useEffect(() => {
    if (!groupIdToInvite) return;
    const unsubscribe = navigation.addListener("transitionEnd", (event) => {
      if (event.data.closing) return;
      unsubscribe();
      router.setParams({ invite: undefined });
      shareInviteLink(groupIdToInvite);
    });
    return unsubscribe;
  }, [groupIdToInvite, navigation]);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  // The description's natural (unclamped) rendered height in px â€” measured
  // via an invisible clone rather than guessed from character/newline count,
  // so "Show more" only appears when the collapsed cap is actually cutting
  // something off. Null until that measurement lands. onTextLayout would be
  // the more direct way to get a line count, but react-native-web doesn't
  // implement it at all, so onLayout + a height comparison is what actually
  // works on both web and native.
  const [descriptionNaturalHeight, setDescriptionNaturalHeight] = useState<number | null>(null);
  // Just the box's height, eased smoothly between collapsed and natural â€”
  // no opacity animation at all. Layering any opacity change on top (a mid-
  // transition dip, or a fade-out/resize/fade-in sequence) was tried and
  // rejected: both read as a flicker of the already-settled text rather
  // than an improvement. A slower, eased (not linear) height animation is
  // what actually reads as one continuous grow instead of lines stepping in.
  const [descriptionHeightAnim] = useState(() => new Animated.Value(DESCRIPTION_COLLAPSED_HEIGHT));
  // Skips animating the very first time a description's height is measured,
  // and again whenever the description text itself changes (edited or
  // switched groups), so the box doesn't visibly animate open on load/edit â€”
  // only an actual Show more/less press should animate (see
  // toggleDescription).
  // Opacity of the gradient softening the clip edge (see DescriptionFade).
  // Kept fully on for the whole height animation in both directions so every
  // line, including the last, passes through the soft edge rather than a hard
  // one; only once an expand has finished does it dissolve, so the fully
  // expanded text ends unobscured.
  const [descriptionFadeAnim] = useState(() => new Animated.Value(1));
  const hasMeasuredDescriptionRef = useRef(false);
  useEffect(() => {
    hasMeasuredDescriptionRef.current = false;
  }, [group?.description]);
  useEffect(() => {
    if (descriptionNaturalHeight === null || hasMeasuredDescriptionRef.current) return;
    hasMeasuredDescriptionRef.current = true;
    const collapsedHeight = Math.min(descriptionNaturalHeight, DESCRIPTION_COLLAPSED_HEIGHT);
    descriptionHeightAnim.setValue(isDescriptionExpanded ? descriptionNaturalHeight : collapsedHeight);
    descriptionFadeAnim.setValue(isDescriptionExpanded ? 0 : 1);
  }, [descriptionNaturalHeight, isDescriptionExpanded, descriptionHeightAnim, descriptionFadeAnim]);
  const toggleDescription = () => {
    const nextExpanded = !isDescriptionExpanded;
    const collapsedHeight =
      descriptionNaturalHeight !== null
        ? Math.min(descriptionNaturalHeight, DESCRIPTION_COLLAPSED_HEIGHT)
        : DESCRIPTION_COLLAPSED_HEIGHT;
    const targetHeight = nextExpanded ? descriptionNaturalHeight ?? DESCRIPTION_COLLAPSED_HEIGHT : collapsedHeight;
    setIsDescriptionExpanded(nextExpanded);
    // Easing.out(cubic) at 320ms front-loads almost all the motion into the
    // first ~15% of the duration, so a single 21px line finishes revealing
    // in well under 100ms â€” too quick for the eye to read as a slide, it
    // reads as a pop/snap instead. inOut spreads the motion evenly across
    // the whole (longer) duration, which is what actually makes the box
    // read as smoothly sliding/uncovering rather than lines appearing.
    Animated.timing(descriptionHeightAnim, {
      toValue: targetHeight,
      duration: 450,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    }).start(({ finished }) => {
      // finished is false if another toggle interrupted this one, which
      // then owns the fade instead.
      if (!finished || !nextExpanded) return;
      Animated.timing(descriptionFadeAnim, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
    // Collapsing starts from fully expanded (fade off), so bring the fade
    // back quickly before the edge starts passing over lines.
    if (!nextExpanded) {
      Animated.timing(descriptionFadeAnim, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    }
  };
  // Whether the collapsed cap actually cuts anything off — gates both the
  // Show more/less toggle and the bottom-edge fade.
  const isDescriptionTruncatable =
    descriptionNaturalHeight !== null && descriptionNaturalHeight > DESCRIPTION_COLLAPSED_HEIGHT + 1;
  const [selectedMember, setSelectedMember] = useState<GroupMember | null>(null);
  const { logs, settleDebt } = useLogs();
  const { members: allMembers, refresh: refreshMembers } = useGroupMembers(group?.id);
  // The list of "other" members is what everything below actually wants;
  // seeing your own name in your own balance list would be meaningless.
  const members = allMembers.filter((member) => member.id !== session?.user.id);
  const viewerIsAdmin = allMembers.find((member) => member.id === session?.user.id)?.isAdmin ?? false;
  // Each pane only drives the hero's collapse once it has enough rows to
  // genuinely scroll (see MIN_ITEMS_TO_COLLAPSE_HERO) â€” group?.id guards
  // this running before the not-found check below, same as useGroupMembers
  // above.
  const groupLogsCount = logs.filter((log) => log.groupId === group?.id).length;
  const isMembersCollapsible = members.length >= MIN_ITEMS_TO_COLLAPSE_HERO;
  const isLogsCollapsible = groupLogsCount >= MIN_ITEMS_TO_COLLAPSE_HERO;
  // Whichever tab is active, if it's not (or no longer) collapsible, the
  // hero should sit fully expanded rather than showing whatever state the
  // other tab's scrolling last left it in â€” scrollY is shared between both
  // panes (see handleMembersScroll/handleLogsScroll above), so switching into a short tab
  // doesn't otherwise reset it on its own. Closing scrollGate (see
  // gatedScrollY above) is what actually guarantees the hero can't move
  // while inactive; zeroing scrollY itself is just so that if the pane
  // later becomes collapsible again, the gate reopens onto a clean 0
  // instead of snapping to whatever scrollY drifted to while gated off.
  //
  // A collapsible tab instead gets scrollY restored from its own pane's last
  // recorded offset (see paneScrollOffsets above), so the hero matches
  // where that pane's list actually is rather than where the other tab's was.
  // A non-collapsible pane's recorded offset is zeroed too: its list is
  // rendered in a different wrapper (see MembersPane/LogsPane), so it
  // remounts at the top and the old offset would be stale if it later
  // becomes collapsible again.
  //
  // Eased rather than set outright, so a switch between a collapsed and an
  // expanded tab slides the hero/title/description into place alongside the
  // tab's own slide instead of teleporting. Both ends of that animation are
  // clamped to heroHeight first: past heroHeight the hero's interpolations
  // are already fully clamped, so starting from a real offset of e.g.
  // 2000px would spend most of the duration visibly doing nothing and then
  // snap at the end â€” clamping changes nothing on screen, and the next real
  // scroll event puts the true offset back anyway. The gate is only closed
  // once a non-collapsible tab's ease back to 0 has actually finished
  // (closing it first would itself be the snap); an interrupted animation
  // (another quick tab switch) leaves that to the next run of this effect.
  const previousActiveTabKeyRef = useRef<TabRoute["key"] | null>(null);
  useEffect(() => {
    if (!isMembersCollapsible) paneScrollOffsets.delete("members");
    if (!isLogsCollapsible) paneScrollOffsets.delete("logs");
    const activeKey = TAB_ROUTES[tabIndex]?.key ?? "members";
    const activeIsCollapsible = activeKey === "members" ? isMembersCollapsible : isLogsCollapsible;
    const previousKey = previousActiveTabKeyRef.current ?? activeKey;
    previousActiveTabKeyRef.current = activeKey;

    scrollY.setValue(Math.min(paneScrollOffsets.get(previousKey) ?? 0, heroHeight));
    const targetOffset = activeIsCollapsible
      ? Math.min(paneScrollOffsets.get(activeKey) ?? 0, heroHeight)
      : 0;
    if (activeIsCollapsible) scrollGate.setValue(1);
    Animated.timing(scrollY, {
      toValue: targetOffset,
      duration: TAB_SWITCH_HERO_DURATION_MS,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !activeIsCollapsible) scrollGate.setValue(0);
    });
    Animated.timing(titleClearanceAnim, {
      // Same formula as titleClearanceForOffset, inlined so this effect's
      // deps stay honest (targetOffset is already clamped to 0..heroHeight).
      toValue: Math.round((targetOffset / heroHeight) * insets.top),
      duration: TAB_SWITCH_HERO_DURATION_MS,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [
    tabIndex,
    isMembersCollapsible,
    isLogsCollapsible,
    heroHeight,
    insets.top,
    scrollY,
    scrollGate,
    titleClearanceAnim,
    paneScrollOffsets,
  ]);

  // Shared across both tabs: the Members list needs it for row debts, the
  // member detail popup (opened from either tab) needs it for its own
  // settle/promote copy, and the header summary needs the total.
  const balances = useMemo(() => {
    if (!group || !session) return {};
    return calculateMemberBalances(logs, group.id, session.user.id);
  }, [logs, group, session]);
  const totalBalance = useMemo(
    () => Object.values(balances).reduce((sum, value) => sum + value, 0),
    [balances]
  );
  // Routed through the same rounded-then-compared formatDebt every per-member
  // row already uses, rather than a raw `totalBalance === 0` check â€” summing
  // several logs' convertedAmount/shareCount divisions can leave a tiny
  // floating-point residue (e.g. 0.00000000002) even once a group is really
  // settled, which fails an exact equality check while still rounding away
  // to 0 for display, showing "You owe 0 EUR" instead of "Settled up".
  const { isSettled: totalIsSettled, isOwed: totalIsOwed, amountLabel: totalAmountLabel } =
    formatDebt(totalBalance, group?.currency ?? "");

  const openMenu = (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    setMenuAnchor({ x: pageX, y: pageY });
  };

  if (!group) {
    return (
      <View style={styles.flex}>
        <PageHeader onBack={goBackOrToGroups} />
        <View style={styles.notFound}>
          <Text style={styles.notFoundText}>This group could not be found.</Text>
        </View>
      </View>
    );
  }

  const currentUserId = session?.user.id ?? "";

  // Opening a member from the Logs tab (tapping one of a log's "purchased
  // for" avatars) should land the viewer on the Members tab underneath the
  // popup, not leave them back on Logs once they close it â€” the Members tab
  // itself doesn't need this, since selecting a member there already leaves
  // you on the right tab.
  const handleSelectMemberFromLogs = (member: GroupMember) => {
    setTabIndex(TAB_ROUTES.findIndex((route) => route.key === "members"));
    setSelectedMember(member);
  };

  // Promote / kick / settle are each confirmed inside MemberDetailOverlay
  // itself (it morphs into a Cancel / confirm step first), so these act
  // directly. Each closes the popup on success; on failure the popup stays
  // on its confirmation so it can be retried or cancelled.
  const handleSettle = async () => {
    if (!selectedMember) return;
    const debt = balances[selectedMember.id] ?? 0;
    const { isOwed, isSettled } = formatDebt(debt, group.currency);
    if (isSettled) return;

    // The debtor is always recorded as paidBy: whichever direction the debt
    // runs, this is the same "who owes whom" logic calculateMemberBalances
    // already uses, just settling it to 0 instead of adding to it.
    const paidBy = isOwed ? selectedMember.id : currentUserId;
    const otherUserId = isOwed ? currentUserId : selectedMember.id;
    settleDebt({
      groupId: group.id,
      paidBy,
      otherUserId,
      amount: Math.abs(Math.round(debt * 100) / 100),
      currency: group.currency,
    }).then(({ error }) => {
      // Unlike new entries, settlements aren't queued offline.
      if (error) Alert.alert("Couldn't settle debt", error);
    });
    setSelectedMember(null);
  };

  const handlePromote = async () => {
    if (!selectedMember) return;
    const { error } = await promoteToAdmin(group.id, selectedMember.id);
    if (error) {
      Alert.alert("Couldn't promote member", error);
      return;
    }
    await refreshMembers();
    setSelectedMember(null);
  };

  const handleKick = async () => {
    if (!selectedMember) return;
    const { error } = await kickMember(group.id, selectedMember.id);
    if (error) {
      Alert.alert("Couldn't remove member", error);
      return;
    }
    await refreshMembers();
    setSelectedMember(null);
  };

  const handleEditGroup = () => {
    setMenuAnchor(null);
    router.push({ pathname: "/new-group", params: { groupId: group.id } });
  };

  // The share sheet is a native presentation, so it must not open while the
  // actions menu's Modal is still on screen animating closed — on iOS it gets
  // presented on top of that Modal, which is then dismissed out from under it,
  // leaving the screen frozen behind a dead overlay. So tapping "Invite
  // member" only closes the menu; the share itself waits for handleMenuClosed.
  const handleInvite = () => {
    pendingInviteRef.current = true;
    setMenuAnchor(null);
  };

  const handleMenuClosed = () => {
    if (!pendingInviteRef.current) return;
    pendingInviteRef.current = false;
    shareInviteLink(group.id);
  };

  const handleAddEntry = () => {
    router.push({ pathname: "/add-entry", params: { groupId: group.id } });
  };

  // Best-effort check for which confirmation copy the menu shows; leave_group
  // itself (schema.sql) makes the actual delete-vs-leave call server-side,
  // so a stale count here can't cause the wrong thing to happen, only the
  // wrong warning to be shown for it.
  const isLastMember = allMembers.filter((member) => member.isActive).length <= 1;

  // Only reached after confirming inside GroupActionsMenu's own leave
  // confirmation, so no separate alert here.
  const handleLeave = () => {
    setMenuAnchor(null);
    removeGroup(group.id);
    goBackOrToGroups();
  };

  const renderScene = ({ route }: { route: TabRoute }) => {
    switch (route.key) {
      case "members":
        return (
          <MembersPane
            currency={group.currency}
            members={members}
            balances={balances}
            onSelectMember={setSelectedMember}
            onScroll={isMembersCollapsible ? handleMembersScroll : undefined}
            minListHeight={isMembersCollapsible ? 0 : nonCollapsibleMinHeight}
            footerHeight={listFooterHeight}
          />
        );
      case "logs":
        return (
          <LogsPane
            groupId={group.id}
            members={members}
            currentUserId={currentUserId}
            viewerName={profile.name}
            viewerAvatarUrl={profile.avatarUrl}
            viewerIsAdmin={viewerIsAdmin}
            groupCurrency={group.currency}
            onSelectMember={handleSelectMemberFromLogs}
            onScroll={isLogsCollapsible ? handleLogsScroll : undefined}
            minListHeight={isLogsCollapsible ? 0 : nonCollapsibleMinHeight}
            footerHeight={listFooterHeight}
          />
        );
    }
  };

  const renderTabBar = (
    props: SceneRendererProps & { navigationState: NavigationState<TabRoute> }
  ) => (
    <SegmentTabBar
      routes={props.navigationState.routes}
      index={props.navigationState.index}
      onSelect={setTabIndex}
    />
  );

  return (
    <View style={styles.flex}>
      {/* Collapsible hero: a full-bleed placeholder today (same pictogram
          idea as the group list's cards), somewhere a real photo drops in
          later. Its translateY is driven by scrollY from whichever tab's
          list is being scrolled, so it slides up and out of view together
          with the title-and-below block below â€” see contentTranslateY.
          Extended upward by insets.top (and re-padded back down inside via
          heroContent) so its own gray fill reaches the true top of the
          screen, behind the status bar â€” otherwise that strip shows
          contentLayer's white through the gap instead, before there's any
          collapsed header there to justify it. */}
      <Animated.View
        style={[
          styles.hero,
          {
            height: heroHeight + insets.top,
            top: -insets.top,
            transform: [{ translateY: heroTranslateY }],
          },
        ]}
      >
        <View style={[styles.heroContent, { marginTop: insets.top }]}>
          <GroupHero
            photoUrl={group.photoUrl}
            motive={group.heroMotive}
            hue={group.heroHue}
            fill="92%"
            verticalAlign="bottom"
          />
          <HeroBackButton
            style={[styles.heroBackButton, { top: insets.top + 8 }]}
            onPress={goBackOrToGroups}
          />
        </View>
      </Animated.View>

      {/* Everything from the title down: rigidly tracks the hero while
          collapsing (contentTranslateY goes heroHeight -> 0 as the hero
          goes 0 -> -heroHeight, so the title arrives exactly at the top
          edge as the hero finishes disappearing), then stays put â€” this
          block's own layout box is always full-screen height regardless of
          scroll, only its paint position moves, so the TabView below can
          still just flex:1 to fill the remaining space. */}
      <Animated.View
        style={[styles.contentLayer, { transform: [{ translateY: contentTranslateY }] }]}
      >
        <Animated.View style={[styles.titleRow, { paddingTop: titlePaddingTop }]}>
          <Text style={[styles.groupName, styles.titleRowGrow]} numberOfLines={1}>
            {group.name}
          </Text>
          <Pressable
            onPress={openMenu}
            hitSlop={6}
            style={[styles.menuButton, menuAnchor && styles.menuButtonActive]}
          >
            <Ionicons name="ellipsis-vertical" size={22} color={Colors.text} />
          </Pressable>
        </Animated.View>

        <View style={styles.titleSeparator} />

        <View style={styles.detailBody}>
          {group.description ? (
            <>
              {/* Invisible, unclamped clone purely to measure how tall the
                  description would really be â€” lets the toggle only appear
                  when the collapsed cap is actually cutting something off,
                  instead of guessing from character/newline count. */}
              <Text
                style={[styles.description, styles.descriptionMeasure, webWordBreakStyle]}
                onLayout={(event) => setDescriptionNaturalHeight(event.nativeEvent.layout.height)}
              >
                {group.description}
              </Text>
              {/* Always renders the full text â€” animating the wrapper's
                  height (rather than toggling numberOfLines) is what makes
                  the grow/shrink smooth. DESCRIPTION_COLLAPSED_HEIGHT is an
                  exact multiple of the line height, so the collapsed clip
                  always lands on a line boundary rather than mid-line.
                  width/minWidth:0 fix a web-only flexbox trap: this View is
                  a flex child, and CSS `word-wrap/overflow-wrap: break-word`
                  (RNW's Text default, and webWordBreakStyle below) only
                  affects painting, not a flex item's automatic min-content
                  width â€” so without an explicit width, the browser still
                  sized this box to fit a long unbreakable word instead of
                  wrapping it, which is what actually clipped the word. */}
              <Animated.View
                style={{
                  height: descriptionHeightAnim,
                  overflow: "hidden",
                  width: "100%",
                  minWidth: 0,
                }}
              >
                <Text style={[styles.description, webWordBreakStyle]}>{group.description}</Text>
                {isDescriptionTruncatable ? (
                  <DescriptionFade opacity={descriptionFadeAnim} />
                ) : null}
              </Animated.View>
              {isDescriptionTruncatable ? (
                <Pressable onPress={toggleDescription} hitSlop={8}>
                  <Text style={styles.showMoreText}>
                    {isDescriptionExpanded ? "Show less" : "Show more"}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}

          <View style={styles.currencyRow}>
            <FlagIcon countryCode={currencyCountryCode(group.currency)} width={20} height={14} />
            <Text style={styles.currencyCode}>{group.currency || "Not set"}</Text>
          </View>
        </View>

        <View style={styles.tabViewWrapper} onLayout={handleTabViewLayout}>
          <TabView<TabRoute>
            navigationState={{ index: tabIndex, routes: TAB_ROUTES }}
            onIndexChange={setTabIndex}
            renderScene={renderScene}
            renderTabBar={renderTabBar}
            initialLayout={{ width: windowWidth }}
            style={styles.tabView}
          />
        </View>
      </Animated.View>

      {/* Moved down here from the tab bar so it reads as a totals footer for
          the whole screen rather than being tied to just one tab. */}
      <View style={[styles.summaryBar, { height: SUMMARY_BAR_HEIGHT + insets.bottom }]}>
        {totalIsSettled ? (
          <Text style={styles.summarySettled}>Settled up</Text>
        ) : (
          <Text
            style={[styles.summaryText, totalIsOwed ? styles.debtPositive : styles.debtNegative]}
          >
            {totalIsOwed ? "You're owed " : "You owe "}
            {totalAmountLabel} in total
          </Text>
        )}
      </View>

      <Pressable
        style={[styles.fab, { bottom: 20 + insets.bottom + SUMMARY_BAR_HEIGHT }]}
        onPress={handleAddEntry}
        hitSlop={4}
      >
        <Ionicons name="add" size={28} color={Colors.accentText} />
      </Pressable>

      <GroupActionsMenu
        anchor={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        onEdit={handleEditGroup}
        onInvite={handleInvite}
        onLeave={handleLeave}
        onClosed={handleMenuClosed}
        canEdit={viewerIsAdmin}
        isLastMember={isLastMember}
      />

      {/* Rendered here rather than inside MembersPane/LogsPane so a member
          tapped from either tab opens the same popup, regardless of which
          tab is currently active. */}
      <MemberDetailOverlay
        member={selectedMember}
        debt={selectedMember ? (balances[selectedMember.id] ?? 0) : 0}
        currency={group.currency}
        viewerIsAdmin={viewerIsAdmin}
        onClose={() => setSelectedMember(null)}
        onSettle={handleSettle}
        onPromote={handlePromote}
        onKick={handleKick}
      />
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
  notFoundText: {
    color: Colors.muted,
    fontSize: 15,
  },
  hero: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 1,
    backgroundColor: Colors.border,
    overflow: "hidden",
  },
  // Reclaims the insets.top the outer hero was stretched upward by (see the
  // comment at its call site), so the photo/back-button still land exactly
  // where they'd have been without that stretch.
  heroContent: {
    flex: 1,
  },
  heroBackButton: {
    position: "absolute",
    left: 16,
    width: 36,
    height: 36,
  },
  // The animated scale target â€” sized to fill heroBackButton exactly so
  // scaling it up doesn't also grow the (static) tap target.
  heroBackButtonCircle: {
    width: "100%",
    height: "100%",
    borderRadius: 18,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  heroBackButtonTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgb(17, 24, 28)",
  },
  // Always full-screen height (top/left/right/bottom all pinned) so its
  // layout never changes as it collapses â€” only its paint position does via
  // the translateY transform â€” which is what lets the TabView inside it
  // keep a stable flex:1 to fill whatever's left under the title/details.
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
    backgroundColor: Colors.background,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  titleRowGrow: {
    flex: 1,
  },
  // A circle around the three dots that's only tinted while its menu is open.
  // Always sized (just transparent when closed), with negative margins so the
  // dots sit exactly where a bare icon would and the title row's height
  // doesn't change.
  menuButton: {
    width: 36,
    height: 36,
    marginVertical: -7,
    marginRight: -7,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonActive: {
    backgroundColor: "rgba(17, 24, 28, 0.1)",
  },
  titleSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
  },
  detailBody: {
    // paddingTop matches the gap below (both 8) so the description sits
    // evenly between the separator above and the currency row below â€”
    // it previously had 20 above (from a uniform `padding: 20`) vs. 8
    // below (from `gap`), which read as lopsided.
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
    gap: 8,
    // Scopes descriptionMeasure's absolute positioning to this container
    // rather than the nearest positioned ancestor further up the tree.
    position: "relative",
  },
  groupName: {
    fontSize: 26,
    fontWeight: "800",
    color: Colors.text,
  },
  description: {
    fontSize: 15,
    lineHeight: 21,
    color: Colors.text,
  },
  descriptionMeasure: {
    // left/right match detailBody's paddingHorizontal (20) â€” an absolutely
    // positioned child is sized against the parent's padding box, not its
    // content box, so 0/0 here would measure against a wider line than the
    // real (inset) description actually wraps at.
    position: "absolute",
    top: 0,
    left: 20,
    right: 20,
    opacity: 0,
    zIndex: -1,
    pointerEvents: "none",
  },
  descriptionFade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: DESCRIPTION_FADE_HEIGHT,
  },
  showMoreText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.accent,
  },
  originalCurrencyNote: {
    fontSize: 13,
    fontStyle: "italic",
    color: Colors.muted,
  },
  currencyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
  },
  currencyCode: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  segmentRow: {
    flexDirection: "row",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  segmentTrack: {
    flexDirection: "row",
    gap: 16,
  },
  segmentPill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: 8,
    backgroundColor: Colors.surfaceSelected,
  },
  segmentItem: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  segmentText: {
    fontSize: 15,
    fontWeight: "500",
    color: Colors.muted,
  },
  segmentTextActive: {
    color: Colors.text,
    fontWeight: "600",
  },
  tabViewWrapper: {
    flex: 1,
  },
  tabView: {
    flex: 1,
  },
  summaryBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Above contentLayer's zIndex:2 (which is full-screen), or that opaque
    // white layer paints over this and the FAB below entirely â€” same fix
    // applied to styles.fab, which turns out to have been missing it too.
    zIndex: 3,
    paddingHorizontal: 20,
    // Centered across the bar's full height, safe-area inset included â€”
    // padding the inset onto the bottom only left the text sitting visibly
    // high on devices with a home indicator. Centered text still clears the
    // indicator itself, which only occupies the last few px of the inset.
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  summaryText: {
    fontSize: 18,
    fontWeight: "700",
    includeFontPadding: false,
  },
  summarySettled: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.muted,
    includeFontPadding: false,
  },
  pane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  paneText: {
    fontSize: 15,
    color: Colors.muted,
  },
  membersList: {
    paddingHorizontal: 20,
    paddingTop: 20,
    // Just normal bottom breathing room â€” the real, guaranteed clearance
    // past the fixed summary bar/FAB comes from each FlatList's own
    // ListFooterComponent spacer (see footerHeight in GroupDetailScreen),
    // which â€” unlike padding baked in here â€” can't be silently neutralized
    // by natural content already being taller than some assumed floor.
    paddingBottom: 20,
    gap: 12,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
  },
  avatarInactive: {
    backgroundColor: Colors.muted,
  },
  // Wraps an <Avatar> so the AdminBadge can sit as a sibling on top of it
  // instead of a child inside it â€” Avatar's own box clips to a circle
  // (needed to crop the photo/initials), which would clip the badge too if
  // it lived in there. This wrapper is unclipped and just big enough to
  // match the avatar's own box, so the badge's position:absolute offsets
  // (styles.adminBadge) still anchor to the circle's edge correctly.
  avatarBadgeWrapper: {
    position: "relative",
  },
  avatarLargeBadgeWrapper: {
    marginBottom: 4,
  },
  adminBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: Colors.background,
  },
  avatarText: {
    color: Colors.accentText,
    fontSize: 14,
    fontWeight: "700",
  },
  memberNameColumn: {
    flex: 1,
    gap: 2,
  },
  memberName: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  memberNameInactive: {
    color: Colors.muted,
  },
  leftLabel: {
    fontSize: 12,
    color: Colors.muted,
  },
  memberDivider: {
    width: 1,
    height: 28,
    backgroundColor: Colors.border,
  },
  debtColumn: {
    alignItems: "flex-end",
    minWidth: 72,
    gap: 2,
  },
  debtLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  debtAmount: {
    fontSize: 14,
    fontWeight: "700",
  },
  debtPositive: {
    color: Colors.success,
  },
  debtNegative: {
    color: Colors.danger,
  },
  debtSettled: {
    fontSize: 13,
    color: Colors.muted,
  },
  logCard: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 10,
  },
  logAmount: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  logPending: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  logPendingText: {
    fontSize: 13,
    color: Colors.muted,
  },
  logAvatars: {
    flexDirection: "row",
  },
  logAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: Colors.background,
    overflow: "hidden",
  },
  logAvatarOverlap: {
    marginLeft: -8,
  },
  logAvatarText: {
    color: Colors.accentText,
    fontSize: 9,
    fontWeight: "700",
  },
  detailBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(17, 24, 28, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  detailBox: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: Colors.background,
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingBottom: 14,
    marginBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  detailHeaderText: {
    flex: 1,
  },
  logDetailTitle: {
    fontSize: 19,
    fontWeight: "800",
    lineHeight: 25,
    color: Colors.text,
  },
  logDetailDescription: {
    fontSize: 16,
    lineHeight: 23,
    color: Colors.text,
  },
  // Given real breathing room from the details/header above (unlike the
  // cramped default spacing every direct child of detailBox would otherwise
  // get â€” see the comment on the Pressable wrapping this popup's content,
  // which swallows detailBox's own `gap` since it's that View's only child).
  detailMembersList: {
    gap: 12,
    marginTop: 20,
  },
  detailMemberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  memberDetailCloseRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  memberDetailHeader: {
    alignItems: "center",
    gap: 6,
    marginTop: -8,
  },
  avatarLarge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
  },
  avatarLargeText: {
    color: Colors.accentText,
    fontSize: 30,
    fontWeight: "700",
  },
  memberDetailName: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
  },
  memberDetailDebt: {
    fontSize: 15,
    fontWeight: "600",
  },
  actionRow: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  // LogEntryActions' container: the icon row's height at rest, growing to the
  // confirmation buttons' height as it morphs (see containerStyle).
  logActions: {
    marginTop: 16,
  },
  logConfirmButtons: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    gap: LOG_BUTTON_GAP,
  },
  logConfirmButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
    paddingHorizontal: LOG_BUTTON_PADDING_X,
  },
  logButtonIconSlot: {
    width: LOG_BUTTON_ICON_SIZE,
    height: LOG_BUTTON_ICON_SIZE,
  },
  logSlidingIcon: {
    position: "absolute",
    top: 0,
    left: 0,
    width: LOG_ICON_SIZE,
    height: LOG_ICON_SIZE,
  },
  actionRowDisabled: {
    opacity: 0.5,
  },
  memberActionFrame: {
    flexDirection: "row",
    alignItems: "center",
    padding: MEMBER_ROW_PADDING,
  },
  // Absolutely placed so the label (not the icon) owns the row's layout
  // position — its own marginLeft carries it past the icon at rest and back
  // flush left as the confirmation title.
  memberActionIcon: {
    position: "absolute",
    left: MEMBER_ROW_PADDING,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  memberDetailRowsList: {
    marginTop: 8,
    gap: MEMBER_ROW_SPACING,
  },
  // Keeps the sliding row above the rows it passes over on its way up.
  memberActionChosen: {
    zIndex: 1,
  },
  // Covers the whole (height-locked) rows area, framed like the action rows
  // it replaces. Its padding matches a row's border + padding, so the
  // stand-in title lines up exactly with the real one sliding into it.
  memberConfirmDetails: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: MEMBER_ROW_PADDING,
  },
  memberConfirmTitle: {
    fontSize: MEMBER_TITLE_FONT_SIZE,
    opacity: 0,
  },
  collapsible: {
    overflow: "hidden",
  },
  // Deliberately lighter and smaller than the member's name above it (20,
  // bold), so the confirmation title doesn't read as a second heading.
  titleText: {
    fontWeight: "600",
  },
  actionRowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
  },
  rowLabel: {
    fontSize: 15,
    color: Colors.text,
  },
  rowLabelDanger: {
    color: Colors.danger,
  },
  fab: {
    position: "absolute",
    right: 20,
    zIndex: 3,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
});
