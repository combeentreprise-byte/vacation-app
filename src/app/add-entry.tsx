import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { Avatar } from "@/components/avatar";
import { CrossfadeLabel } from "@/components/crossfade-label";
import { CurrencyPickerModal } from "@/components/currency-picker";
import { ModalHeader } from "@/components/modal-header";
import { FocusTextInput, PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import { CURRENCIES } from "@/constants/currencies";
import { LOG_DETAILS_MAX_LENGTH, LOG_DETAILS_MAX_LINES } from "@/constants/limits";
import { useAuth } from "@/hooks/use-auth";
import { useGroupAccess } from "@/hooks/use-group-access";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLineLimit } from "@/hooks/use-line-limit";
import { useLogs } from "@/hooks/use-logs";
import { useOpenUnlock } from "@/hooks/use-open-unlock";
import { useProfile } from "@/hooks/use-profile";
import { useRefreshOnRefocus } from "@/hooks/use-refresh-on-refocus";
import { entriesNeedUnlock, freeEntriesLeft, isMemberUnlocked, joinNames } from "@/utils/access";
import { getExchangeRate } from "@/utils/exchange-rates";

const MEMBER_GRID_GAP = 10;
const MEMBER_TILE_PADDING = 8;
const MEMBER_TILE_BORDER = 1;
// How much narrower a tile's name has to be than the tile itself.
const MEMBER_TILE_HORIZONTAL_INSET = 2 * (MEMBER_TILE_PADDING + MEMBER_TILE_BORDER);
const TILE_SELECT_ANIMATION = { duration: 320, easing: Easing.inOut(Easing.quad) };
const UNSELECTED_AVATAR_OPACITY = 0.4;
// "Select all" / "Deselect all" ripples through the tiles one after another
// in display order — this is the gap between neighbours, shrunk for big
// groups so the whole ripple never takes longer than CASCADE_MAX_SPREAD_MS.
const CASCADE_STEP_MS = 60;
const CASCADE_MAX_SPREAD_MS = 480;
const SELF_TILE_ID = "self";
// A tile briefly swells when it becomes selected (or dips when deselected),
// then eases back — a single pop, no overshoot.
const TILE_POP_SCALE = 1.08;
const TILE_UNPOP_SCALE = 0.92;
const TILE_POP_GROW = { duration: 110, easing: Easing.out(Easing.quad) };
const TILE_POP_SETTLE = { duration: 180, easing: Easing.inOut(Easing.quad) };
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

// Packs tiles of the given widths (already sorted shortest first) into rows
// of at most two, pairing a tile with the next one whenever both fit the row.
function packWideRows<T extends { width: number }>(tiles: T[], rowWidth: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < tiles.length; i++) {
    const next = tiles[i + 1];
    if (next && tiles[i].width + MEMBER_GRID_GAP + next.width <= rowWidth) {
      rows.push([tiles[i], next]);
      i++;
    } else {
      rows.push([tiles[i]]);
    }
  }
  return rows;
}

function MemberTile({
  name,
  label = name,
  avatarUrl,
  selected,
  locked = false,
  animationDelay = 0,
  onToggle,
  style,
}: {
  name: string;
  // Shown under the avatar when it should differ from `name` (e.g. "You"),
  // while the avatar's initials still come from the real name.
  label?: string;
  avatarUrl: string | null;
  selected: boolean;
  // Not unlocked while the group's entries need everyone on them to be:
  // shown with a lock badge. Still tappable — the screen decides what a tap
  // does (deselect, or explain why they can't be picked).
  locked?: boolean;
  // How long to wait before animating a change to `selected` — nonzero only
  // while a "Select all" / "Deselect all" cascade is playing.
  animationDelay?: number;
  onToggle: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  // Eases between selected/unselected (on the UI thread) rather than
  // snapping, so "Select all" / "Deselect all" flipping every tile at once
  // reads as one smooth change.
  const selection = useSharedValue(selected ? 1 : 0);
  const scale = useSharedValue(1);
  // Skips the pop on mount — only a change after the tile first rendered
  // should pop.
  const hasMounted = useRef(false);
  useEffect(() => {
    selection.set(withDelay(animationDelay, withTiming(selected ? 1 : 0, TILE_SELECT_ANIMATION)));
    if (hasMounted.current) {
      scale.set(
        withDelay(
          animationDelay,
          withSequence(
            withTiming(selected ? TILE_POP_SCALE : TILE_UNPOP_SCALE, TILE_POP_GROW),
            withTiming(1, TILE_POP_SETTLE)
          )
        )
      );
    }
    hasMounted.current = true;
    // Only a change to `selected` should (re)start the animation — a delay
    // left over from the last cascade mustn't replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selection, scale]);
  const tileStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(selection.value, [0, 1], [Colors.border, Colors.accent]),
    transform: [{ scale: scale.value }],
  }));
  const avatarStyle = useAnimatedStyle(() => ({
    opacity: UNSELECTED_AVATAR_OPACITY + (1 - UNSELECTED_AVATAR_OPACITY) * selection.value,
  }));
  const nameStyle = useAnimatedStyle(() => ({
    color: interpolateColor(selection.value, [0, 1], [Colors.muted, Colors.text]),
  }));
  return (
    <AnimatedPressable
      style={[styles.memberTile, style, tileStyle]}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: locked && !selected }}
      accessibilityHint={locked ? "Not unlocked" : undefined}
    >
      <View>
        <Animated.View style={avatarStyle}>
          <Avatar
            name={name}
            avatarUrl={avatarUrl}
            style={styles.memberAvatar}
            textStyle={styles.memberAvatarText}
          />
        </Animated.View>
        {locked ? (
          <View style={styles.lockBadge}>
            <Ionicons name="lock-closed" size={10} color={Colors.accentText} />
          </View>
        ) : null}
      </View>
      <Animated.Text style={[styles.memberTileName, nameStyle]} numberOfLines={1}>
        {label}
      </Animated.Text>
    </AnimatedPressable>
  );
}

export default function AddEntryScreen() {
  const { groupId, prefillAmount, prefillCurrency, scanId, logId } = useLocalSearchParams<{
    groupId: string;
    // Set when arriving from the Scan tab's receipt flow (see
    // scan-pick-group.tsx), or when this form's own "Scan receipt" button
    // hands a result back (see scan-receipt.tsx) — the amount/currency
    // extracted from the photo, still just a starting point the user can
    // edit before submitting.
    prefillAmount?: string;
    prefillCurrency?: string;
    // Fresh per scan-receipt.tsx result, so a scan arriving on this
    // already-mounted form is applied even if its amount repeats the last.
    scanId?: string;
    // Set when arriving from a log's detail popup's "Edit entry" button —
    // switches this same form into edit-and-save-in-place mode.
    logId?: string;
  }>();
  const isEditMode = !!logId;
  const { session } = useAuth();
  const { profile } = useProfile();
  const { groups } = useGroups();
  const { logs, addLog, updateLog } = useLogs();
  const { members: allMembers } = useGroupMembers(groupId);
  const group = groups.find((item) => item.id === groupId);
  const existingLog = isEditMode ? logs.find((log) => log.id === logId) : undefined;
  // The checklist is for splitting with other people; your own share is
  // handled separately via "Myself included". Members who've left the group
  // can't be picked for a new split, though they remain visible on past
  // entries that already included them.
  const members = allMembers.filter(
    (member) => member.id !== session?.user.id && member.isActive
  );
  // Editing an entry that was split with someone who's since left or deleted
  // their account can't offer them back as a tile — but silently
  // dropping them from the split on save would shrink shareCount and
  // retroactively change everyone else's historical balance (the same thing
  // create_log's null-member handling exists to prevent). So their slot is
  // preserved untouched and only re-appended on submit; the picker below
  // only ever lets the user change the *other*, still-editable slots.
  const preservedMemberIds =
    existingLog?.memberIds.filter(
      (id) => id === null || !members.some((member) => member.id === id)
    ) ?? [];

  // Once the group's free entries are used up (one pool everyone in it
  // shares), everyone on an entry has to be unlocked — you (always its payer)
  // and everyone it's split with — the same rule create_log/update_log
  // enforce server-side (check_entry_access in schema.sql), checked here
  // first so it's clear before submitting. Edits use one too. This device's
  // entries in the group still waiting to sync count against the free ones
  // (other than the one being edited, and held ones, which were turned down).
  const { access: groupAccess, refresh: refreshGroupAccess } = useGroupAccess(groupId);
  // Back from the paywall (its "Unlock to add entries" button), this form's copy
  // of the group's access predates the purchase.
  useRefreshOnRefocus(refreshGroupAccess);
  const pendingInGroup = logs.filter(
    (log) => log.groupId === groupId && log.isPending && !log.isHeld && log.id !== logId
  ).length;
  const needsUnlock = entriesNeedUnlock(groupAccess, pendingInGroup);
  const isLocked = (id: string) => needsUnlock && !isMemberUnlocked(groupAccess, id);
  const viewerLocked = !!session && isLocked(session.user.id);
  const openUnlock = useOpenUnlock();
  const memberName = (id: string) =>
    allMembers.find((member) => member.id === id)?.name ?? "Someone";
  // Only non-null ids: a deleted account's slot has no one left to unlock
  // (check_entry_access skips those too).
  const lockedPreservedIds = preservedMemberIds.filter(
    (id): id is string => id !== null && isLocked(id)
  );
  // The member whose tile was last tapped while locked, to say why nothing
  // happened.
  const [lockedTapId, setLockedTapId] = useState<string | null>(null);

  // A scanned amount of 0/negative/NaN isn't usable, and a scanned currency
  // that isn't one of ours (e.g. the model misread it, or it's a currency
  // exchange-rates.ts can't convert) shouldn't silently override the
  // group's own currency — so both are validated before ever reaching state.
  const scannedAmount = Number(prefillAmount);
  const isPrefilled = !!prefillAmount && Number.isFinite(scannedAmount) && scannedAmount > 0;
  const validPrefillCurrency =
    prefillCurrency && CURRENCIES.some((c) => c.code === prefillCurrency)
      ? prefillCurrency
      : undefined;

  const [amount, setAmount] = useState(() =>
    existingLog ? String(existingLog.amount) : isPrefilled ? prefillAmount! : ""
  );
  const [currency, setCurrency] = useState(
    () => existingLog?.currency ?? validPrefillCurrency ?? group?.currency ?? ""
  );
  // useState initializers above only cover a prefill present on mount; a
  // scan returned by scan-receipt.tsx arrives later, as new params on this
  // same still-mounted screen. It also overrides an edited log's existing
  // amount — rescanning while editing is an explicit request to replace it.
  // Adjusted during render (React's "storing information from previous
  // renders" pattern) rather than in an effect, to avoid a wasted extra render.
  const [lastAppliedScanId, setLastAppliedScanId] = useState(scanId);
  if (scanId && scanId !== lastAppliedScanId) {
    setLastAppliedScanId(scanId);
    if (isPrefilled) setAmount(prefillAmount!);
    if (validPrefillCurrency) setCurrency(validPrefillCurrency);
  }
  const [isCurrencyPickerVisible, setIsCurrencyPickerVisible] = useState(false);
  const [details, setDetails] = useState(() => existingLog?.details ?? "");
  const detailsLineLimit = useLineLimit(details, setDetails, LOG_DETAILS_MAX_LINES);
  // Can't be seeded synchronously like the fields above — useGroupMembers
  // fetches on its own per-screen mount, so `members` is still empty on
  // this component's first render even though `existingLog` (from the
  // already-loaded, app-wide LogsProvider) is available immediately. Seeded
  // once via the effect below instead, as soon as the member list actually
  // has something to match against.
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const hasSeededSelection = useRef(false);
  useEffect(() => {
    if (!existingLog || hasSeededSelection.current || allMembers.length === 0) return;
    hasSeededSelection.current = true;
    const seeded: Record<string, boolean> = {};
    existingLog.memberIds.forEach((id) => {
      if (id && members.some((member) => member.id === id)) seeded[id] = true;
    });
    setSelectedIds(seeded);
  }, [existingLog, allMembers, members]);
  const [includeMyself, setIncludeMyself] = useState(existingLog?.payerIncluded ?? true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // "Select all" covers yourself too, since you appear as a tile alongside
  // everyone else.
  // Tiles are a third of the row wide, laid out in explicit rows of three
  // (not a wrapping row of third-wide tiles — float rounding can make three
  // of those overflow the row and wrap two per row). A name that doesn't fit
  // a third gets a tile exactly as wide as the name needs (capped at the full
  // row), placed after all the standard rows so the uniform grid stays intact
  // up top — shortest first, two to a row wherever two fit. Names are
  // measured off-screen at their natural one-line width, so the grid stays
  // invisible until every one has reported it.
  const [gridWidth, setGridWidth] = useState(0);
  const [nameWidths, setNameWidths] = useState<Record<string, number>>({});
  const defaultTileWidth = Math.max(0, (gridWidth - 2 * MEMBER_GRID_GAP) / 3);
  // +1 of slack so sub-pixel rounding never cuts a name that just fits.
  const neededTileWidth = (id: string) =>
    Math.ceil(nameWidths[id] ?? 0) + 1 + MEMBER_TILE_HORIZONTAL_INSET;
  const isWideTile = (id: string) => neededTileWidth(id) > defaultTileWidth;
  const standardMembers = members.filter((member) => !isWideTile(member.id));
  const wideTiles = members
    .filter((member) => isWideTile(member.id))
    .map((member) => ({ member, width: Math.min(gridWidth, neededTileWidth(member.id)) }))
    .sort(
      (a, b) =>
        a.width - b.width ||
        (nameWidths[a.member.id] ?? 0) - (nameWidths[b.member.id] ?? 0)
    );
  const wideRows = packWideRows(wideTiles, gridWidth);
  const orderedMembers = [...standardMembers, ...wideTiles.map((tile) => tile.member)];
  const isGridMeasured =
    gridWidth > 0 && members.every((member) => nameWidths[member.id] !== undefined);
  const handleNameLayout = (id: string) => (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setNameWidths((current) => (current[id] === width ? current : { ...current, [id]: width }));
  };

  // Locked members can't be picked, so "Select all" means everyone who can be.
  const allSelected =
    includeMyself &&
    members.every((member) => isLocked(member.id) || selectedIds[member.id]);

  // Per-tile animation delays for the "Select all" / "Deselect all" cascade;
  // cleared by any single-tile tap so that one animates straight away.
  const [cascadeDelays, setCascadeDelays] = useState<Record<string, number>>({});

  const toggleMember = (id: string) => {
    setCascadeDelays({});
    // A locked member can still be taken off an entry (one being edited may
    // already include them), just not put on one.
    if (isLocked(id) && !selectedIds[id]) {
      setLockedTapId(id);
      return;
    }
    setLockedTapId(null);
    setSelectedIds((current) => ({ ...current, [id]: !current[id] }));
  };

  const toggleMyself = () => {
    setCascadeDelays({});
    setIncludeMyself((current) => !current);
  };

  const toggleAll = () => {
    const next = !allSelected;
    const updated: Record<string, boolean> = {};
    members.forEach((member) => {
      updated[member.id] = next && !isLocked(member.id);
    });
    // The selection itself changes all at once (so the form is immediately
    // valid); only the animation is staggered, across the tiles that actually
    // flip, in the order they're shown.
    const changing = [
      ...(includeMyself !== next ? [SELF_TILE_ID] : []),
      ...orderedMembers
        .filter((member) => !!selectedIds[member.id] !== updated[member.id])
        .map((m) => m.id),
    ];
    setLockedTapId(null);
    const step =
      changing.length > 1
        ? Math.min(CASCADE_STEP_MS, CASCADE_MAX_SPREAD_MS / (changing.length - 1))
        : 0;
    setCascadeDelays(Object.fromEntries(changing.map((id, index) => [id, index * step])));
    setSelectedIds(updated);
    setIncludeMyself(next);
  };

  // decimal-pad shows a comma instead of a period as the decimal separator on
  // many European locales, but `Number()` treats "12,50" as NaN — normalize
  // before parsing so a comma-entered amount isn't silently rejected.
  const amountValue = Number(amount.trim().replace(",", "."));
  // A preserved (deleted/departed-member) slot already guarantees a
  // non-empty split even if nothing in the editable checklist is checked,
  // so it counts toward "there's a valid split" the same as a selected tile.
  const hasSelection = Object.values(selectedIds).some(Boolean) || preservedMemberIds.length > 0;
  // Picked but not unlocked: an entry being edited that already had them, or
  // someone picked before the group's access had loaded.
  const lockedSelectedIds = Object.keys(selectedIds).filter(
    (id) => selectedIds[id] && isLocked(id)
  );
  // Saving this uses one of the group's free entries unless everyone on it
  // is unlocked, so the count shows whenever someone on it isn't — including
  // to an unlocked person splitting with a locked one.
  const usesFreeEntry =
    !isMemberUnlocked(groupAccess, session?.user.id ?? "") ||
    Object.keys(selectedIds).some((id) => selectedIds[id] && !isMemberUnlocked(groupAccess, id));
  const freeEntriesShown =
    groupAccess?.paywallEnabled && usesFreeEntry ? freeEntriesLeft(groupAccess, pendingInGroup) : 0;
  const canSubmit =
    amount.trim().length > 0 &&
    !Number.isNaN(amountValue) &&
    amountValue > 0 &&
    hasSelection &&
    !viewerLocked &&
    lockedSelectedIds.length === 0 &&
    lockedPreservedIds.length === 0 &&
    !isSubmitting;
  // Whichever explanation applies to the lock state, shown above the button.
  const lockedSelectedNames = lockedSelectedIds.map(memberName);
  const accessNote = viewerLocked
    ? isEditMode
      ? "This group's free entries are used up, so editing one needs an unlock. Settling up and deleting your own entries stay free."
      : "This group's free entries are used up, so adding one needs an unlock. Settling up and deleting your own entries stay free."
    : lockedPreservedIds.length > 0
      ? `${joinNames(lockedPreservedIds.map(memberName))} left the group and ${lockedPreservedIds.length === 1 ? "isn't" : "aren't"} unlocked, so this entry can't be changed anymore. You can still delete it.`
      : lockedSelectedNames.length > 0
        ? `${joinNames(lockedSelectedNames)} ${lockedSelectedNames.length === 1 ? "isn't" : "aren't"} unlocked, so they can't be on entries yet. Tap to take them off.`
        : lockedTapId
          ? `${memberName(lockedTapId)} isn't unlocked, so they can't be on entries yet.`
          : null;

  const handleSubmit = async () => {
    if (!canSubmit || !groupId || !session || !group) return;
    if (isEditMode && !existingLog) return;
    const effectiveCurrency = currency.trim() || group.currency || "";
    if (effectiveCurrency !== currency) {
      setCurrency(effectiveCurrency);
    }

    setIsSubmitting(true);
    let convertedAmount = amountValue;
    if (effectiveCurrency !== group.currency) {
      try {
        const rate = await getExchangeRate(effectiveCurrency, group.currency);
        convertedAmount = amountValue * rate;
      } catch {
        // getExchangeRate already falls back to the rates this device saved
        // last time it was online, so this only happens offline for a
        // currency pair it has never looked up.
        setIsSubmitting(false);
        Alert.alert(
          "Couldn't convert currency",
          `There's no saved exchange rate from ${effectiveCurrency} to ${group.currency} on this device yet. Connect to the internet once and try again, or enter the amount in ${group.currency}.`,
          [{ text: "OK" }]
        );
        return;
      }
    }

    const memberIds = [
      ...preservedMemberIds,
      ...Object.keys(selectedIds).filter((id) => selectedIds[id]),
    ];

    if (isEditMode && existingLog) {
      const { error } = await updateLog(existingLog.id, {
        groupId,
        amount: amountValue,
        convertedAmount,
        convertedCurrency: group.currency,
        currency: effectiveCurrency,
        details: details.trim(),
        memberIds,
        paidBy: existingLog.paidBy,
        payerIncluded: includeMyself,
      });
      setIsSubmitting(false);
      if (error) {
        Alert.alert("Couldn't save changes", error);
        return;
      }
      router.back();
      return;
    }

    await addLog({
      groupId,
      amount: amountValue,
      convertedAmount,
      convertedCurrency: group.currency,
      currency: effectiveCurrency,
      details: details.trim(),
      memberIds,
      paidBy: session.user.id,
      payerIncluded: includeMyself,
    });
    setIsSubmitting(false);
    router.back();
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ModalHeader title={isEditMode ? "Edit entry" : "Add entry"} onClose={() => router.back()} />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.field}>
          <Text style={styles.label}>Amount you spent</Text>
          <View style={styles.amountRow}>
            <FocusTextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={Colors.muted}
              keyboardType="decimal-pad"
              style={[styles.input, styles.amountInput]}
            />
            <PressableScale
              style={[styles.input, styles.currencyInput]}
              onPress={() => setIsCurrencyPickerVisible(true)}
            >
              <Text style={currency ? styles.currencyValue : styles.currencyPlaceholder}>
                {currency || "USD"}
              </Text>
            </PressableScale>
          </View>
          {isPrefilled ? (
            <Text style={styles.prefillHint}>Filled in from your scanned receipt — double-check it.</Text>
          ) : null}
          <PressableScale
            style={styles.scanButton}
            pressedScale={0.98}
            onPress={() =>
              router.push({
                pathname: "/scan-receipt",
                params: { groupId, ...(logId ? { logId } : {}) },
              })
            }
          >
            <Ionicons name="receipt-outline" size={18} color={Colors.accent} />
            <Text style={styles.scanButtonText}>Scan receipt</Text>
          </PressableScale>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Details</Text>
          <FocusTextInput
            value={details}
            {...detailsLineLimit}
            placeholder="What was this for?"
            placeholderTextColor={Colors.muted}
            style={[styles.input, styles.textArea]}
            multiline
            textAlignVertical="top"
            maxLength={LOG_DETAILS_MAX_LENGTH}
          />
          <Text style={styles.charCount}>
            {details.length}/{LOG_DETAILS_MAX_LENGTH} characters
          </Text>
        </View>

        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Purchase was for</Text>
            <PressableScale onPress={toggleAll} hitSlop={8} pressedOpacity={0.5}>
              <CrossfadeLabel
                first="Select all"
                second="Deselect all"
                showSecond={allSelected}
                align="right"
                style={styles.selectAllText}
              />
            </PressableScale>
          </View>
          <View onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}>
            <View style={styles.nameMeasurerClip} pointerEvents="none" aria-hidden>
              <View style={styles.nameMeasurer}>
                {members.map((member) => (
                  <Text
                    key={member.id}
                    style={styles.memberTileName}
                    onLayout={handleNameLayout(member.id)}
                  >
                    {member.name}
                  </Text>
                ))}
              </View>
            </View>
            <View style={[styles.memberGrid, !isGridMeasured && styles.memberGridHidden]}>
              {chunk(
                [
                  <MemberTile
                    key={SELF_TILE_ID}
                    name={profile.name}
                    label="You"
                    avatarUrl={profile.avatarUrl}
                    selected={includeMyself}
                    animationDelay={cascadeDelays[SELF_TILE_ID]}
                    onToggle={toggleMyself}
                    style={styles.memberTileStandard}
                  />,
                  ...standardMembers.map((member) => (
                    <MemberTile
                      key={member.id}
                      name={member.name}
                      avatarUrl={member.avatarUrl}
                      selected={!!selectedIds[member.id]}
                      locked={isLocked(member.id)}
                      animationDelay={cascadeDelays[member.id]}
                      onToggle={() => toggleMember(member.id)}
                      style={styles.memberTileStandard}
                    />
                  )),
                ],
                3
              ).map((row, index) => (
                <View key={index} style={styles.memberRow}>
                  {row}
                  {/* Fillers keep a short last row's tiles a third wide. */}
                  {Array.from({ length: 3 - row.length }, (_, i) => (
                    <View key={`filler-${i}`} style={styles.memberTileStandard} />
                  ))}
                </View>
              ))}
              {wideRows.map((row) => (
                <View key={row[0].member.id} style={styles.memberRow}>
                  {row.map(({ member, width }) => (
                    <MemberTile
                      key={member.id}
                      name={member.name}
                      avatarUrl={member.avatarUrl}
                      selected={!!selectedIds[member.id]}
                      locked={isLocked(member.id)}
                      animationDelay={cascadeDelays[member.id]}
                      onToggle={() => toggleMember(member.id)}
                      style={{ width }}
                    />
                  ))}
                </View>
              ))}
            </View>
          </View>
        </View>

        {accessNote ? (
          <View style={styles.accessNote}>
            <Ionicons name="lock-closed-outline" size={16} color={Colors.muted} />
            <Text style={styles.accessNoteText}>{accessNote}</Text>
          </View>
        ) : freeEntriesShown > 0 ? (
          <Text style={styles.freeEntriesHint}>
            {freeEntriesShown === 1 ? "1 free entry" : `${freeEntriesShown} free entries`} left in
            this group
          </Text>
        ) : null}

        {viewerLocked ? (
          <PressableScale
            style={styles.submitButton}
            pressedScale={0.98}
            onPress={() => openUnlock({ groupId })}
          >
            <Text style={styles.submitButtonText}>
              {isEditMode ? "Unlock to edit entries" : "Unlock to add entries"}
            </Text>
          </PressableScale>
        ) : (
          // Disabled dimming lives on a wrapper — PressableScale animates the
          // button's own opacity, which would override it.
          <View style={!canSubmit && styles.submitButtonDisabled}>
            <PressableScale
              style={styles.submitButton}
              pressedScale={0.98}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              <Text style={styles.submitButtonText}>
                {isSubmitting
                  ? isEditMode
                    ? "Saving..."
                    : "Submitting..."
                  : isEditMode
                    ? "Save changes"
                    : "Submit entry"}
              </Text>
            </PressableScale>
          </View>
        )}
      </ScrollView>

      <CurrencyPickerModal
        visible={isCurrencyPickerVisible}
        selectedCode={currency}
        onSelect={(code) => {
          setCurrency(code);
          setIsCurrencyPickerVisible(false);
        }}
        onClose={() => setIsCurrencyPickerVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  form: {
    padding: 20,
    gap: 20,
  },
  field: {
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
  },
  amountRow: {
    flexDirection: "row",
    gap: 10,
  },
  charCount: {
    marginTop: 6,
    fontSize: 12,
    color: Colors.muted,
    textAlign: "right",
  },
  prefillHint: {
    marginTop: 6,
    fontSize: 13,
    color: Colors.muted,
  },
  amountInput: {
    flex: 1,
  },
  scanButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
  },
  scanButtonText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  currencyInput: {
    width: 84,
  },
  currencyValue: {
    fontSize: 16,
    color: Colors.text,
    textAlign: "center",
  },
  currencyPlaceholder: {
    fontSize: 16,
    color: Colors.muted,
    textAlign: "center",
  },
  textArea: {
    height: 120,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectAllText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.accent,
  },
  memberGrid: {
    gap: MEMBER_GRID_GAP,
  },
  memberGridHidden: {
    opacity: 0,
  },
  memberRow: {
    flexDirection: "row",
    gap: MEMBER_GRID_GAP,
  },
  // Lays every name out on one line at its natural width, out of sight, to
  // tell which ones need a wide tile and how wide. The inner view is far
  // wider than any name so nothing wraps; the zero-height clip keeps it from
  // widening the page.
  nameMeasurerClip: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 0,
    overflow: "hidden",
    opacity: 0,
  },
  nameMeasurer: {
    width: 10000,
    alignItems: "flex-start",
  },
  memberTile: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: MEMBER_TILE_PADDING,
    borderWidth: MEMBER_TILE_BORDER,
    borderColor: Colors.border,
    borderRadius: 12,
  },
  memberTileStandard: {
    flex: 1,
    flexBasis: 0,
  },
  memberAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  memberAvatarText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "700",
  },
  memberTileName: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.text,
    textAlign: "center",
  },
  // Same corner placement as the group screen's AdminBadge.
  lockBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.background,
    backgroundColor: Colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  accessNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  accessNoteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.muted,
  },
  freeEntriesHint: {
    fontSize: 13,
    color: Colors.muted,
    textAlign: "center",
  },
  submitButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
});
