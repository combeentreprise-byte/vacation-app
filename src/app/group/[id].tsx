import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  type GestureResponderEvent,
  Image,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type NavigationState,
  type SceneRendererProps,
  TabView,
} from "react-native-tab-view";

import { FlagIcon } from "@/components/currency-picker";
import { GroupActionsMenu } from "@/components/group-actions-menu";
import { GroupHero } from "@/components/hero-motive";
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

const TAB_ROUTES: TabRoute[] = [
  { key: "members", title: "Members" },
  { key: "logs", title: "Logs" },
];

// The hero photo placeholder's collapsed height (same idea as the group
// list's fixed-ratio cards, just sized for a full-bleed detail-page hero
// rather than a small list row).
const HERO_HEIGHT_RATIO = 0.28;

// The summary bar's own height above insets.bottom (paddingTop 14 +
// ~22 of text + paddingBottom 14) — used to lift the FAB clear of it,
// since the bar itself has no ListFooter/layout the FAB could measure.
const SUMMARY_BAR_HEIGHT = 50;

// How many lines a collapsed description shows before offering "Show more".
const DESCRIPTION_COLLAPSED_LINES = 4;
// Matches styles.description's lineHeight — used to compute the collapsed
// pixel height a measured description is compared against (see
// descriptionMeasure below). Kept as a constant rather than read back from
// the stylesheet since RN style objects aren't guaranteed to round-trip.
const DESCRIPTION_LINE_HEIGHT = 21;
const DESCRIPTION_COLLAPSED_HEIGHT = DESCRIPTION_COLLAPSED_LINES * DESCRIPTION_LINE_HEIGHT;
// react-native-web's default text wrapping (like a browser's) only breaks at
// spaces, so a long unbroken run of characters (a URL, a typo with no
// spaces) overflows its box instead of wrapping — and since the description
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
// aside (that part varies per-device and gets added at each call site) —
// the real geometry only (summary bar + the FAB floating above it), with no
// extra padding baked in. A flat safety margin on top of this used to be
// applied unconditionally (48, then 148px), which is what actually caused
// the "half the phone is whitespace" complaint once scrolled to the true
// bottom of a collapsible list — a fixed pixel value that was way oversized
// relative to a shorter device's screen. The visible gap below the last row
// is now added at the call site as a fraction of the actual device height
// instead, so it scales down on smaller screens instead of dominating them.
const BOTTOM_OBSTRUCTION_HEIGHT = SUMMARY_BAR_HEIGHT + FAB_BOTTOM_MARGIN + FAB_DIAMETER;
// The extra breathing room below the last row, past what's strictly needed
// to clear the summary bar/FAB — expressed as a fraction of device height,
// not a flat pixel count, so it scales down on shorter screens instead of
// dominating them. Was 0.1 (~10% of device height): on top of
// BOTTOM_OBSTRUCTION_HEIGHT and the list's own trailing gap/padding, that
// added up to a visible gap of ~240-256px on a typical phone, noticeably
// more than needed just to keep the last row clear of the FAB. Trimmed to
// this much smaller ratio — still a real, non-zero comfort margin so the
// last row doesn't sit flush against the FAB, but most of the clearance
// now comes from BOTTOM_OBSTRUCTION_HEIGHT (the FAB/bar's real, immovable
// footprint) rather than this discretionary top-up. Don't drop this to 0
// or remove it: some margin here is still what keeps the last row from
// touching the FAB on the smallest supported screens.
const BOTTOM_CLEARANCE_GAP_RATIO = 0.02;

// Below this many rows, a pane's content is too short to ever scroll for
// real — tying the hero's collapse to that pane's scroll position just
// means reacting to rubber-band/bounce noise instead of an actual scroll
// gesture, which is what caused the flicker this constant exists to avoid.
const MIN_ITEMS_TO_COLLAPSE_HERO = 7;

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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

// Shared by every place a member is shown (list rows, detail popups, log
// avatar stacks): renders the real photo when the profile has one, falling
// back to initials otherwise. `style` supplies the circle's own size/
// background (styles.avatar, .avatarLarge, .logAvatar, ...), each of which
// needs `overflow: "hidden"` for the image to actually clip to the circle.
// A caller that also shows an AdminBadge wraps this in styles.avatarBadgeWrapper
// rather than passing it in here — Avatar's own box clips to the circle, which
// would clip the badge's overhang too if the badge lived inside it.
function Avatar({
  name,
  avatarUrl,
  style,
  textStyle,
}: {
  name: string;
  avatarUrl?: string | null;
  style: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}) {
  return (
    <View style={style}>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} />
      ) : (
        <Text style={textStyle}>{getInitials(name)}</Text>
      )}
    </View>
  );
}

// Shared entrance/exit animation for the detail popups (member + log): the
// backdrop fades while the card scales up from a slight shrink, and reverses
// symmetrically on close. RN's Modal has no exit-animation hook of its own
// (setting visible={false} unmounts immediately), so this keeps the Modal
// mounted through the closing animation via its own `isMounted` state and
// only lets the parent's `isOpen` go false once that animation finishes.
// The optional `onClosed` fires at that same moment — real completion of the
// close animation, not a guessed duration — so a caller that wants to open a
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
  // reference). Updated in its own effect, not during render — React
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
// using their real name/initials rather than a placeholder — this list
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
      // delete_account in schema.sql) — the log_members/paid_by row is kept
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
// own header. A settlement gets a fixed generic title here — the specifics
// (who settled with whom, for how much) move to formatSettlementDetail
// instead, shown where a regular entry's own details text would go, since
// "You"/other-name substitution and per-entry amounts read better as a full
// sentence in the popup body than crammed into a list-row headline.
// Always uses convertedAmount + the group's own currency, never log.amount/
// log.currency (the originally-entered ones) — see formatOriginalCurrencyNote
// for where that original figure still surfaces.
function formatLogHeadline(log: LogEntry, payerName: string, groupCurrency: string) {
  if (log.isSettlement) return "Debt settlement";
  const amount = Math.round(log.convertedAmount * 100) / 100;
  return `${payerName} spent ${amount} ${groupCurrency}`;
}

// The full sentence for a settlement entry's detail popup, shown in place of
// a regular entry's (user-entered) details text — settle_debt always stores
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
// one — either logged in another currency to begin with, or the group's
// currency changed since (change_group_currency rescales convertedAmount but
// deliberately leaves the original amount/currency alone) — this surfaces
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
  onSettle: () => void;
  onPromote: () => void;
  onKick: () => void;
}) {
  const { isMounted, progress } = usePopupAnimation(!!member);
  // Kept in sync only while a member is set, so the popup's content doesn't
  // flash to its "nothing selected" state while it animates closed (Modal
  // stays mounted for that whole animation — see usePopupAnimation). Set
  // directly during render (not an effect) per React's documented pattern
  // for adjusting state in response to a prop change.
  const [displayMember, setDisplayMember] = useState(member);
  const [displayDebt, setDisplayDebt] = useState(debt);
  if (member && (member !== displayMember || debt !== displayDebt)) {
    setDisplayMember(member);
    setDisplayDebt(debt);
  }

  const { isSettled, isOwed, amountLabel } = formatDebt(displayDebt, currency);
  const [promoteFillAnim] = useState(() => new Animated.Value(0));
  const [promoteRowWidth, setPromoteRowWidth] = useState(0);

  const targetIsAdmin = displayMember?.isAdmin ?? false;
  const targetIsActive = displayMember?.isActive ?? false;
  // Only an admin can promote, only a non-admin can be promoted, and only an
  // active member can be promoted at all — any of those failing grays the
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
  // merged together (see DELETED_USER_ID in balances.ts) — there's no real
  // account left to record a settlement against, so this is grayed out
  // regardless of whether its merged balance happens to be zero.
  const targetIsDeleted = displayMember?.id === DELETED_USER_ID;
  const promoteFillWidth = promoteFillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const handlePromotePressIn = () => {
    Animated.timing(promoteFillAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: false,
      // Only reaching full black (not just tapping/releasing early) counts
      // as "held long enough" — a pressOut before this fires interrupts the
      // animation, so `finished` comes back false and nothing happens.
    }).start(({ finished }) => {
      if (finished) onPromote();
    });
  };

  const handlePromotePressOut = () => {
    Animated.timing(promoteFillAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
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

                <View style={styles.memberDetailRowsList}>
                  <Pressable
                    style={[styles.actionRow, !canPromote && styles.actionRowDisabled]}
                    onLayout={(event) => setPromoteRowWidth(event.nativeEvent.layout.width)}
                    onPress={() => { }}
                    onPressIn={handlePromotePressIn}
                    onPressOut={handlePromotePressOut}
                    disabled={!canPromote}
                  >
                    <Animated.View
                      pointerEvents="none"
                      style={[styles.promoteFill, { width: promoteFillWidth }]}
                    />
                    <View style={styles.actionRowContent} pointerEvents="none">
                      <Ionicons name="arrow-up" size={20} color={Colors.text} />
                      <Text style={styles.rowLabel}>{promoteLabel}</Text>
                    </View>
                    {/* White copy of the same content, revealed only where the
                      black fill has swept past, so the text appears to
                      invert to white as the wipe passes under it. */}
                    <Animated.View
                      pointerEvents="none"
                      style={[styles.promoteRevealClip, { width: promoteFillWidth }]}
                    >
                      <View style={[styles.actionRowContent, { width: promoteRowWidth }]}>
                        <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
                        <Text style={[styles.rowLabel, styles.rowLabelWhite]}>{promoteLabel}</Text>
                      </View>
                    </Animated.View>
                  </Pressable>
                  <Pressable
                    style={[styles.actionRow, !canKick && styles.actionRowDisabled]}
                    onPress={onKick}
                    disabled={!canKick}
                  >
                    <View style={styles.actionRowContent}>
                      <Ionicons name="person-remove-outline" size={20} color={Colors.danger} />
                      <Text style={[styles.rowLabel, styles.rowLabelDanger]}>
                        Kick group member
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.actionRow,
                      (isSettled || targetIsDeleted) && styles.actionRowDisabled,
                    ]}
                    onPress={onSettle}
                    disabled={isSettled || targetIsDeleted}
                  >
                    <View style={styles.actionRowContent}>
                      <MaterialCommunityIcons name="handshake-outline" size={20} color={Colors.text} />
                      <Text style={styles.rowLabel}>Debt was settled</Text>
                    </View>
                  </Pressable>
                </View>
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
  // Left undefined below the row threshold — see isMembersCollapsible in
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
  // (minListHeight > 0) — see nonCollapsibleMinHeight in GroupDetailScreen
  // for why this needs to cap the list's own box, not just its content's
  // minHeight. Left completely unwrapped for a collapsible pane
  // (minListHeight === 0), which already fills the full tab area correctly
  // as the TabView scene's direct child — wrapping it here too would swap
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
  // so there's nothing to conflict with here — this fills the same slot a
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

                    // Tapping yourself doesn't lead anywhere — the member detail
                    // popup's settle/promote/kick actions all assume a target
                    // other than the viewer. Same for a "Deleted user"
                    // placeholder (see resolvePurchasedFor) — there's no real
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
                  displayLog.isSettlement ? (
                    // Settlements don't go through the regular expense edit
                    // form (update_log excludes them — see schema.sql), so
                    // only delete makes sense here.
                    <Pressable
                      style={[styles.actionRow, styles.logDeleteRow]}
                      onPress={() => onDelete(displayLog)}
                    >
                      <View style={styles.actionRowContent}>
                        <Ionicons name="trash-outline" size={20} color={Colors.danger} />
                        <Text style={[styles.rowLabel, styles.rowLabelDanger]}>Delete entry</Text>
                      </View>
                    </Pressable>
                  ) : (
                    <View style={[styles.logActionRowGroup, styles.logDeleteRow]}>
                      <Pressable
                        style={[styles.actionRow, styles.logActionHalf]}
                        onPress={() => onEdit(displayLog)}
                      >
                        <View style={styles.actionRowContent}>
                          <Ionicons name="create-outline" size={20} color={Colors.text} />
                          <Text style={styles.rowLabel}>Edit entry</Text>
                        </View>
                      </Pressable>
                      <Pressable
                        style={[styles.actionRow, styles.logActionHalf]}
                        onPress={() => onDelete(displayLog)}
                      >
                        <View style={styles.actionRowContent}>
                          <Ionicons name="trash-outline" size={20} color={Colors.danger} />
                          <Text style={[styles.rowLabel, styles.rowLabelDanger]}>Delete entry</Text>
                        </View>
                      </Pressable>
                    </View>
                  )
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
  // Left undefined below the row threshold — see isLogsCollapsible in
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
  // opened here directly — it's stashed and only opened once the log
  // popup's Modal has actually finished closing (see onFullyClosed below).
  // RN's Modal is a native full-screen presentation on both platforms:
  // opening a second one before the first has genuinely finished dismissing
  // can silently drop the new one on iOS, and has been known to leave a
  // dead, untouchable overlay on Android — a fixed-duration setTimeout guess
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

  const handleDelete = (log: LogEntry) => {
    // Deleting isn't reversible from the UI, so confirm first — same
    // reasoning as the settle-debt confirmation.
    Alert.alert("Delete entry?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error } = await deleteLog(log.id);
          if (error) {
            Alert.alert("Couldn't delete entry", error);
            return;
          }
          setSelectedLog(null);
        },
      },
    ]);
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

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const { profile } = useProfile();
  const { groups, removeGroup, promoteToAdmin, kickMember } = useGroups();
  const group = groups.find((item) => item.id === id);
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const heroHeight = windowHeight * HERO_HEIGHT_RATIO;
  // A short list (few members/logs) can end up with less content height
  // than its own visible viewport, which makes it not genuinely scrollable
  // — on a real device that shows up as janky, flickery rubber-band/bounce
  // scroll deltas feeding straight into the hero/title transform above,
  // since those are driven directly off raw scroll position. Forcing the
  // content container to be at least as tall as its own real viewport plus
  // a bit extra fixes that — measured via onLayout rather than guessed,
  // since the viewport itself already varies with insets/hero size in ways
  // not worth re-deriving here. Falls back to the full window height until
  // the first layout pass lands, so there's no flash of the old
  // (too-short-to-scroll) behavior before that.
  //
  // That "bit extra" has two parts, both required: heroHeight, since
  // scrollY needs to actually reach heroHeight for the collapse animation
  // above to reach its fully-collapsed end (any less and the hero can
  // never fully disappear, no matter how far the list scrolls) — plus the
  // summary bar's own height, so the last row can still clear it once
  // fully scrolled.
  const [tabViewHeight, setTabViewHeight] = useState(0);
  const handleTabViewLayout = (event: LayoutChangeEvent) => {
    setTabViewHeight(event.nativeEvent.layout.height);
  };
  // Just the "genuinely scrollable at all" guarantee (see the flicker this
  // was built to prevent) — a floor on total content height, nothing more.
  // Deliberately NOT where the bottom-bar/FAB clearance lives anymore: a
  // floor has no effect once real content already exceeds it (which a
  // normal-length list does easily), silently dropping whatever margin was
  // baked into the floor's formula. Clearance instead comes from
  // listFooterHeight below, an actual spacer appended after the last row,
  // which stays in effect unconditionally regardless of content length.
  //
  // Only meaningful for a non-collapsible pane (see nonCollapsibleMinHeight
  // usage below) — applying this same viewport-sized floor to a collapsible
  // (>= MIN_ITEMS_TO_COLLAPSE_HERO row) pane too was actively harmful: if
  // that pane's real content + footer happened to add up to less than a
  // full viewport, the floor padded out the *entire remaining difference*
  // as literal blank space below the last row — which is how "half the
  // screen" of dead space happened. A collapsible-by-count list is already
  // long enough that it doesn't need this floor for genuine scrollability.
  //
  // Subtracts heroHeight because a non-collapsible pane's hero never slides
  // away (scrollGate stays shut for it — see below), so contentLayer sits
  // permanently offset by heroHeight and only (tabViewHeight - heroHeight)
  // of it is ever painted inside the actual screen — the remaining
  // heroHeight at the bottom of tabViewHeight is real layout space that
  // exists below the visible viewport and can never be scrolled into view.
  // Sizing the pane off the full tabViewHeight (as before) let its FlatList
  // believe it had that much real viewport to work with, so a pane whose
  // rows fell just short of MIN_ITEMS_TO_COLLAPSE_HERO but still added up
  // to close to a screenful — enough to push the trailing footerHeight
  // spacer past the true (smaller) visible height — would stop scrolling
  // heroHeight short of its real end, permanently hiding that spacer (and
  // the last row's intended clearance) behind the summary bar/FAB with no
  // way to scroll it into view. Applied below as this pane's own explicit
  // height (see MembersPane/LogsPane's `style`), not just its content's
  // minHeight, so the FlatList's internal scroll viewport matches what's
  // actually on screen and its true end is always reachable.
  const nonCollapsibleMinHeight = Math.max(0, (tabViewHeight || windowHeight) - heroHeight);
  // One footer height for both collapsible and non-collapsible panes — the
  // real bottom-bar/FAB clearance (BOTTOM_OBSTRUCTION_HEIGHT) plus a small
  // gap sized off the actual device height (BOTTOM_CLEARANCE_GAP_RATIO),
  // not a flat pixel value — a flat value either undershoots on a tall
  // device or, as a large one did here, dominates a short one. A
  // collapsible (>= MIN_ITEMS_TO_COLLAPSE_HERO row) pane used to also bake
  // heroHeight's worth of extra into this same trailing footer, on the
  // theory that it needed that much guaranteed scroll *distance* to ever
  // reach fully-collapsed. But that distance is needed early in the
  // scroll, to let the collapse animation finish — a real multi-row list's
  // own natural content is already comfortably taller than a viewport
  // (that's what makes it collapsible in the first place), so it doesn't
  // need extra reserved *at the very end* too; baking it into the
  // permanent trailing footer just left dead space sitting below the last
  // row forever, long after the collapse had already finished.
  const listFooterHeight =
    BOTTOM_OBSTRUCTION_HEIGHT + insets.bottom + windowHeight * BOTTOM_CLEARANCE_GAP_RATIO;
  // Shared by both tabs' lists (see MembersPane/LogsPane's onScroll) so
  // scrolling either one collapses the same hero — only one tab is ever
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
  // 0/1 gate instead — multiplying by 0 forces the output to 0 no matter
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
  // under the status bar/notch once fully collapsed and pinned — but that
  // same clearance is dead space at rest, when the title is sitting well
  // below the hero already (see the previous white-gap fix). paddingTop
  // can't ride the native-driven transform above (padding isn't
  // transform/opacity, so it can't be natively animated), hence this
  // JS-side value deriving a plain 0..insets.top value from the same
  // scroll offset instead — a small, deliberately rounded-to-the-pixel
  // re-render cost during scroll, not a 60fps-critical animation.
  //
  // This used to be a gatedScrollY.addListener() effect, but a JS listener
  // attached to a *derived* native-driven node (gatedScrollY is an
  // Animated.multiply -> interpolate chain fed by a useNativeDriver: true
  // event) is not reliable — on-device it never fired at all, even though
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
  const [titleClearance, setTitleClearance] = useState(0);
  const handleTitleClearanceScroll = (event: {
    nativeEvent: { contentOffset: { y: number } };
  }) => {
    const progress = Math.min(1, Math.max(0, event.nativeEvent.contentOffset.y / heroHeight));
    const next = Math.round(progress * insets.top);
    setTitleClearance((current) => (current === next ? current : next));
  };
  const handlePaneScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: true, listener: handleTitleClearanceScroll }
  );
  const [tabIndex, setTabIndex] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  // The description's natural (unclamped) rendered height in px — measured
  // via an invisible clone rather than guessed from character/newline count,
  // so "Show more" only appears when the collapsed cap is actually cutting
  // something off. Null until that measurement lands. onTextLayout would be
  // the more direct way to get a line count, but react-native-web doesn't
  // implement it at all, so onLayout + a height comparison is what actually
  // works on both web and native.
  const [descriptionNaturalHeight, setDescriptionNaturalHeight] = useState<number | null>(null);
  // Just the box's height, eased smoothly between collapsed and natural —
  // no opacity animation at all. Layering any opacity change on top (a mid-
  // transition dip, or a fade-out/resize/fade-in sequence) was tried and
  // rejected: both read as a flicker of the already-settled text rather
  // than an improvement. A slower, eased (not linear) height animation is
  // what actually reads as one continuous grow instead of lines stepping in.
  const [descriptionHeightAnim] = useState(() => new Animated.Value(DESCRIPTION_COLLAPSED_HEIGHT));
  // Skips animating the very first time a description's height is measured,
  // and again whenever the description text itself changes (edited or
  // switched groups), so the box doesn't visibly animate open on load/edit —
  // only an actual Show more/less press should animate (see
  // toggleDescription).
  const hasMeasuredDescriptionRef = useRef(false);
  useEffect(() => {
    hasMeasuredDescriptionRef.current = false;
  }, [group?.description]);
  useEffect(() => {
    if (descriptionNaturalHeight === null || hasMeasuredDescriptionRef.current) return;
    hasMeasuredDescriptionRef.current = true;
    const collapsedHeight = Math.min(descriptionNaturalHeight, DESCRIPTION_COLLAPSED_HEIGHT);
    descriptionHeightAnim.setValue(isDescriptionExpanded ? descriptionNaturalHeight : collapsedHeight);
  }, [descriptionNaturalHeight, isDescriptionExpanded, descriptionHeightAnim]);
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
    // in well under 100ms — too quick for the eye to read as a slide, it
    // reads as a pop/snap instead. inOut spreads the motion evenly across
    // the whole (longer) duration, which is what actually makes the box
    // read as smoothly sliding/uncovering rather than lines appearing.
    Animated.timing(descriptionHeightAnim, {
      toValue: targetHeight,
      duration: 450,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    }).start();
  };
  const [selectedMember, setSelectedMember] = useState<GroupMember | null>(null);
  const { logs, settleDebt } = useLogs();
  const { members: allMembers, refresh: refreshMembers } = useGroupMembers(group?.id);
  // The list of "other" members is what everything below actually wants;
  // seeing your own name in your own balance list would be meaningless.
  const members = allMembers.filter((member) => member.id !== session?.user.id);
  const viewerIsAdmin = allMembers.find((member) => member.id === session?.user.id)?.isAdmin ?? false;
  // Each pane only drives the hero's collapse once it has enough rows to
  // genuinely scroll (see MIN_ITEMS_TO_COLLAPSE_HERO) — group?.id guards
  // this running before the not-found check below, same as useGroupMembers
  // above.
  const groupLogsCount = logs.filter((log) => log.groupId === group?.id).length;
  const isMembersCollapsible = members.length >= MIN_ITEMS_TO_COLLAPSE_HERO;
  const isLogsCollapsible = groupLogsCount >= MIN_ITEMS_TO_COLLAPSE_HERO;
  // Whichever tab is active, if it's not (or no longer) collapsible, the
  // hero should sit fully expanded rather than showing whatever state the
  // other tab's scrolling last left it in — scrollY is shared between both
  // panes (see handlePaneScroll below), so switching into a short tab
  // doesn't otherwise reset it on its own. Closing scrollGate (see
  // gatedScrollY above) is what actually guarantees the hero can't move
  // while inactive; zeroing scrollY itself is just so that if the pane
  // later becomes collapsible again, the gate reopens onto a clean 0
  // instead of snapping to whatever scrollY drifted to while gated off.
  useEffect(() => {
    const activeIsCollapsible =
      TAB_ROUTES[tabIndex]?.key === "members" ? isMembersCollapsible : isLogsCollapsible;
    scrollGate.setValue(activeIsCollapsible ? 1 : 0);
    if (!activeIsCollapsible) {
      scrollY.setValue(0);
    }
  }, [tabIndex, isMembersCollapsible, isLogsCollapsible, scrollY, scrollGate]);
  // No onScroll fires for a non-collapsible pane, so
  // handleTitleClearanceScroll never runs to bring titleClearance back down
  // on its own when switching into one — it could otherwise keep whatever
  // value it last had from a previous (collapsible) tab. Derived at use
  // rather than reset via setState-in-an-effect, which both avoids an extra
  // render and can't ever be one render stale the way the effect version
  // briefly was.
  const activeTabIsCollapsible =
    TAB_ROUTES[tabIndex]?.key === "members" ? isMembersCollapsible : isLogsCollapsible;
  const effectiveTitleClearance = activeTabIsCollapsible ? titleClearance : 0;

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
  // row already uses, rather than a raw `totalBalance === 0` check — summing
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
  // popup, not leave them back on Logs once they close it — the Members tab
  // itself doesn't need this, since selecting a member there already leaves
  // you on the right tab.
  const handleSelectMemberFromLogs = (member: GroupMember) => {
    setTabIndex(TAB_ROUTES.findIndex((route) => route.key === "members"));
    setSelectedMember(member);
  };

  const handleSettle = () => {
    if (!selectedMember) return;
    const debt = balances[selectedMember.id] ?? 0;
    const { amountLabel, isOwed, isSettled } = formatDebt(debt, group.currency);
    if (isSettled) return;

    // A settlement can't be undone from the UI once created, so confirm
    // first rather than silently writing a permanent log entry.
    Alert.alert(
      "Mark debt as settled?",
      `This adds a log entry recording that ${isOwed ? `${selectedMember.name} paid you` : `you paid ${selectedMember.name}`} ${amountLabel}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () => {
            // The debtor is always recorded as paidBy: whichever direction
            // the debt runs, this is the same "who owes whom" logic
            // calculateMemberBalances already uses, just settling it to 0
            // instead of adding to it.
            const paidBy = isOwed ? selectedMember.id : currentUserId;
            const otherUserId = isOwed ? currentUserId : selectedMember.id;
            settleDebt({
              groupId: group.id,
              paidBy,
              otherUserId,
              amount: Math.abs(Math.round(debt * 100) / 100),
              currency: group.currency,
            });
            setSelectedMember(null);
          },
        },
      ]
    );
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

  const handleKick = () => {
    if (!selectedMember) return;
    const member = selectedMember;

    // Removing someone can't be undone from the UI, so confirm first — same
    // reasoning as every other irreversible-feeling action in this popup.
    Alert.alert(
      `Remove ${member.name}?`,
      `They'll be removed from this group. Their existing logs and balances stay visible, and they can rejoin later via an invite link.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            const { error } = await kickMember(group.id, member.id);
            if (error) {
              Alert.alert("Couldn't remove member", error);
              return;
            }
            await refreshMembers();
            setSelectedMember(null);
          },
        },
      ]
    );
  };

  const handleEditGroup = () => {
    setMenuAnchor(null);
    router.push({ pathname: "/new-group", params: { groupId: group.id } });
  };

  const handleInvite = () => {
    setMenuAnchor(null);
    const url = Linking.createURL(`join/${group.id}`);
    Share.share({ message: url }).catch((error) => {
      Alert.alert("Couldn't open share sheet", String(error));
    });
  };

  const handleAddEntry = () => {
    router.push({ pathname: "/add-entry", params: { groupId: group.id } });
  };

  const handleLeave = () => {
    setMenuAnchor(null);
    // Best-effort check for which confirmation copy to show; leave_group
    // itself (schema.sql) makes the actual delete-vs-leave call server-side,
    // so a stale count here can't cause the wrong thing to happen, only the
    // wrong warning to be shown for it.
    const isLastMember = allMembers.filter((member) => member.isActive).length <= 1;

    Alert.alert(
      isLastMember ? "Delete group" : "Leave group",
      isLastMember
        ? "You're the last member of this group. Leaving will permanently delete the group and all its logs and balances — this can't be undone."
        : "Are you sure you want to leave this group?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isLastMember ? "Delete" : "Leave",
          style: "destructive",
          onPress: () => {
            removeGroup(group.id);
            goBackOrToGroups();
          },
        },
      ]
    );
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
            onScroll={isMembersCollapsible ? handlePaneScroll : undefined}
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
            onScroll={isLogsCollapsible ? handlePaneScroll : undefined}
            minListHeight={isLogsCollapsible ? 0 : nonCollapsibleMinHeight}
            footerHeight={listFooterHeight}
          />
        );
    }
  };

  const renderTabBar = (
    props: SceneRendererProps & { navigationState: NavigationState<TabRoute> }
  ) => (
    <View style={styles.segmentRow}>
      {props.navigationState.routes.map((route, i) => {
        const isActive = i === props.navigationState.index;
        return (
          <Pressable
            key={route.key}
            onPress={() => setTabIndex(i)}
            style={[styles.segmentItem, isActive && styles.segmentItemActive]}
          >
            <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>
              {route.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={styles.flex}>
      {/* Collapsible hero: a full-bleed placeholder today (same pictogram
          idea as the group list's cards), somewhere a real photo drops in
          later. Its translateY is driven by scrollY from whichever tab's
          list is being scrolled, so it slides up and out of view together
          with the title-and-below block below — see contentTranslateY.
          Extended upward by insets.top (and re-padded back down inside via
          heroContent) so its own gray fill reaches the true top of the
          screen, behind the status bar — otherwise that strip shows
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
          <Pressable
            style={[styles.heroBackButton, { top: insets.top + 8 }]}
            onPress={goBackOrToGroups}
            hitSlop={12}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.text} />
          </Pressable>
        </View>
      </Animated.View>

      {/* Everything from the title down: rigidly tracks the hero while
          collapsing (contentTranslateY goes heroHeight -> 0 as the hero
          goes 0 -> -heroHeight, so the title arrives exactly at the top
          edge as the hero finishes disappearing), then stays put — this
          block's own layout box is always full-screen height regardless of
          scroll, only its paint position moves, so the TabView below can
          still just flex:1 to fill the remaining space. */}
      <Animated.View
        style={[styles.contentLayer, { transform: [{ translateY: contentTranslateY }] }]}
      >
        <View style={[styles.titleRow, { paddingTop: 12 + effectiveTitleClearance }]}>
          <Text style={[styles.groupName, styles.titleRowGrow]} numberOfLines={1}>
            {group.name}
          </Text>
          <Pressable onPress={openMenu} hitSlop={12}>
            <Ionicons name="ellipsis-vertical" size={22} color={Colors.text} />
          </Pressable>
        </View>

        <View style={styles.titleSeparator} />

        <View style={styles.detailBody}>
          {group.description ? (
            <>
              {/* Invisible, unclamped clone purely to measure how tall the
                  description would really be — lets the toggle only appear
                  when the collapsed cap is actually cutting something off,
                  instead of guessing from character/newline count. */}
              <Text
                style={[styles.description, styles.descriptionMeasure, webWordBreakStyle]}
                onLayout={(event) => setDescriptionNaturalHeight(event.nativeEvent.layout.height)}
              >
                {group.description}
              </Text>
              {/* Always renders the full text — animating the wrapper's
                  height (rather than toggling numberOfLines) is what makes
                  the grow/shrink smooth. DESCRIPTION_COLLAPSED_HEIGHT is an
                  exact multiple of the line height, so the collapsed clip
                  always lands on a line boundary rather than mid-line.
                  width/minWidth:0 fix a web-only flexbox trap: this View is
                  a flex child, and CSS `word-wrap/overflow-wrap: break-word`
                  (RNW's Text default, and webWordBreakStyle below) only
                  affects painting, not a flex item's automatic min-content
                  width — so without an explicit width, the browser still
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
              </Animated.View>
              {descriptionNaturalHeight !== null &&
              descriptionNaturalHeight > DESCRIPTION_COLLAPSED_HEIGHT + 1 ? (
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
      <View style={[styles.summaryBar, { paddingBottom: 14 + insets.bottom }]}>
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
        canEdit={viewerIsAdmin}
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
    borderRadius: 18,
    backgroundColor: "rgba(17, 24, 28, 0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Always full-screen height (top/left/right/bottom all pinned) so its
  // layout never changes as it collapses — only its paint position does via
  // the translateY transform — which is what lets the TabView inside it
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
  titleSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
  },
  detailBody: {
    // paddingTop matches the gap below (both 8) so the description sits
    // evenly between the separator above and the currency row below —
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
    // left/right match detailBody's paddingHorizontal (20) — an absolutely
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
    gap: 16,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  segmentItem: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  segmentItemActive: {
    backgroundColor: Colors.surfaceSelected,
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
    // white layer paints over this and the FAB below entirely — same fix
    // applied to styles.fab, which turns out to have been missing it too.
    zIndex: 3,
    paddingTop: 14,
    paddingHorizontal: 20,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  summaryText: {
    fontSize: 16,
    fontWeight: "700",
  },
  summarySettled: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.muted,
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
    // Just normal bottom breathing room — the real, guaranteed clearance
    // past the fixed summary bar/FAB comes from each FlatList's own
    // ListFooterComponent spacer (see footerHeight in GroupDetailScreen),
    // which — unlike padding baked in here — can't be silently neutralized
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
  // instead of a child inside it — Avatar's own box clips to a circle
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
  // get — see the comment on the Pressable wrapping this popup's content,
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
  memberDetailRowsList: {
    marginTop: 8,
    gap: 12,
  },
  actionRow: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  // The log detail popup's "Delete entry" row isn't wrapped in a rows-list
  // container the way MemberDetailOverlay's actionRows are (that wrapper —
  // memberDetailRowsList — is what gives those their spacing), so it needs
  // its own margin to sit apart from the participants list above it.
  logDeleteRow: {
    marginTop: 20,
  },
  logActionRowGroup: {
    flexDirection: "row",
    gap: 12,
  },
  logActionHalf: {
    flex: 1,
  },
  actionRowDisabled: {
    opacity: 0.5,
  },
  actionRowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
  },
  promoteFill: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: "#000000",
  },
  promoteRevealClip: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
  },
  rowLabel: {
    fontSize: 15,
    color: Colors.text,
  },
  rowLabelWhite: {
    color: "#FFFFFF",
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
