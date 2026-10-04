import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  interpolate,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChoiceRow, HOP_ANIMATION } from "@/components/plan-upgrade-card";
import { PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import {
  formatPrice,
  GROUP_PLAN_SIZES,
  JUST_ME_SEATS,
  PLAN_PERIODS,
  type PlanKind,
  type PlanPeriod,
  planPrice,
  subscriptionPeriodOf,
} from "@/constants/plans";
import { useAccess } from "@/hooks/use-access";
import { useAuth } from "@/hooks/use-auth";
import { useLogs } from "@/hooks/use-logs";
import { goBackOrToGroups } from "@/utils/navigation";
import { purchasePlan, upgradeSubscription } from "@/utils/purchases";

type IconName = ComponentProps<typeof Ionicons>["name"];
type Point = { icon: IconName; title: string; detail: string };

// Page 1: what the app does.
const SOLUTIONS: Point[] = [
  {
    icon: "wallet-outline",
    title: "Every expense in one place",
    detail: "Anyone in the group adds what they paid in seconds, so nothing slips through.",
  },
  {
    icon: "people-outline",
    title: "Always know who owes whom",
    detail: "Balances update with every entry. No spreadsheets, no group-chat maths.",
  },
  {
    icon: "globe-outline",
    title: "Any currency, converted for you",
    detail: "Pay in whatever's local. Everything is worked out in your group's currency.",
  },
  {
    icon: "scan-outline",
    title: "Scan the receipt",
    detail: "Snap a photo and the amount and currency fill themselves in.",
  },
];

// Page 2: what a Trip Pass is and why it's worth it.
const TRIP_PASS_PERKS: Point[] = [
  {
    icon: "infinite-outline",
    title: "Unlimited entries, the whole trip",
    detail: "One payment unlocks adding and editing for a week or two, in every group you're in.",
  },
  {
    icon: "people-circle-outline",
    title: "Cover your whole group",
    detail: "Get a seat for everyone, up to 15 people. The bigger the group, the less it costs each.",
  },
  {
    icon: "calendar-outline",
    title: "Start whenever you want",
    detail: "Buy it now and pick the day it starts. It doesn't count down until then.",
  },
];

// The reassurances above the pricing tabs, for whichever tab is picked.
const PRICING_CHECKS: Record<PlanKind, string[]> = {
  trip_pass: [
    "Pay once. It simply ends — nothing renews.",
    "Viewing balances and settling up always stay free.",
  ],
  subscription: [
    "Subscribe to be unlocked all year round.",
    "Cancel anytime.",
    "We'll notify you two days before it renews.",
  ],
};

const TABS: { key: PlanKind; label: string }[] = [
  { key: "trip_pass", label: "Trip Passes" },
  { key: "subscription", label: "Subscriptions" },
];

const SIZES = [JUST_ME_SEATS, ...GROUP_PLAN_SIZES];

// What a period costs, per its own term.
function priceLabel(period: PlanPeriod, seatCount: number) {
  const price = formatPrice(planPrice(period, seatCount));
  if (period === "month") return `${price} / month`;
  if (period === "year") return `${price} / year`;
  return price;
}

// The two-tab switch on the pricing page. The blue pill slides sideways to
// the picked tab, with the same single hop as ChoiceRow's outline.
function PlanTabs({ selected, onSelect }: { selected: PlanKind; onSelect: (kind: PlanKind) => void }) {
  const [segmentWidth, setSegmentWidth] = useState(0);
  const index = TABS.findIndex((tab) => tab.key === selected);
  const progress = useSharedValue(index);

  useEffect(() => {
    progress.set(withTiming(index, HOP_ANIMATION));
  }, [index, progress]);

  const pillStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: progress.value * segmentWidth }],
  }));

  return (
    <View
      style={styles.tabs}
      onLayout={(event) =>
        setSegmentWidth((event.nativeEvent.layout.width - TABS_PADDING * 2) / TABS.length)
      }
      accessibilityRole="tablist"
    >
      {segmentWidth > 0 ? (
        <Animated.View pointerEvents="none" style={[styles.tabPill, pillStyle]} />
      ) : null}
      {TABS.map((tab) => {
        const isSelected = tab.key === selected;
        return (
          <Pressable
            key={tab.key}
            style={styles.tab}
            onPress={() => onSelect(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
          >
            <Text style={[styles.tabLabel, isSelected && styles.tabLabelSelected]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// One dot per page; the current one stretches into a pill, following the
// swipe as it happens.
function PageDot({
  index,
  scrollX,
  pageWidth,
  onPress,
}: {
  index: number;
  scrollX: SharedValue<number>;
  pageWidth: number;
  onPress: () => void;
}) {
  const dotStyle = useAnimatedStyle(() => {
    const closeness = interpolate(
      scrollX.value / pageWidth,
      [index - 1, index, index + 1],
      [0, 1, 0],
      "clamp"
    );
    return {
      width: 8 + closeness * 14,
      backgroundColor: interpolateColor(closeness, [0, 1], [Colors.border, Colors.accent]),
    };
  });
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={`Page ${index + 1}`}>
      <Animated.View style={[styles.dot, dotStyle]} />
    </Pressable>
  );
}

function PageHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.heading}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{detail}</Text>
    </View>
  );
}

function PointRow({ point }: { point: Point }) {
  return (
    <View style={styles.point}>
      <View style={styles.pointIcon}>
        <Ionicons name={point.icon} size={22} color={Colors.accent} />
      </View>
      <View style={styles.pointText}>
        <Text style={styles.pointTitle}>{point.title}</Text>
        <Text style={styles.pointDetail}>{point.detail}</Text>
      </View>
    </View>
  );
}

function CheckRow({ text }: { text: string }) {
  return (
    <View style={styles.checkRow}>
      <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
      <Text style={styles.checkText}>{text}</Text>
    </View>
  );
}

// The full-screen sales pitch for plans, as three swipeable pages: what the
// app does, what a Trip Pass is, then pricing — Trip Passes (pay once, for just
// you or a group) on one tab, subscriptions (always just you) on the other.
// A bought Trip Pass goes on to /plan-setup to pick its group and start.
// It's what every "Unlock" in the app opens. Only someone who has never had
// a plan (bought one or held a seat) gets all three pages; everyone else —
// and `pricingOnly=1`, from "Get another plan" on /plans — just gets the
// pricing page, since they already know what a plan is. `full=1` always
// shows all three (the dev-only preview button on the groups tab).
// `groupId` (opened from a group) preselects that group when setting up a
// group pass, and `justMe=1` (the group plan screen's "Unlock just me")
// starts the size on "Just me" and, like `pricingOnly=1`, skips straight to
// the pricing page — they're already looking at a group's plan. Only one subscription runs at a time
// (test_purchase_plan), so for someone who already has one the
// Subscriptions tab only offers yearly: on monthly the button upgrades to
// it, on yearly it just opens the one they have — either way they end up
// on /subscription.
export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const { pricingOnly, full, groupId, justMe } = useLocalSearchParams<{
    pricingOnly?: string;
    full?: string;
    groupId?: string;
    justMe?: string;
  }>();
  const { access, refresh: refreshAccess } = useAccess();
  const { session } = useAuth();
  // Cancelled ones included, until they run out.
  const currentSubscription =
    access.activePlans.find(
      (plan) => plan.kind === "subscription" && plan.sponsorId === session?.user.id
    ) ?? null;
  const currentSubscriptionPeriod = currentSubscription
    ? subscriptionPeriodOf(currentSubscription.durationDays)
    : null;
  const { syncPending } = useLogs();
  // Decided once, on opening: buying here makes hasHadPlan true, which
  // shouldn't reshuffle the pages on the way out.
  const [isPricingOnly] = useState(
    () => full !== "1" && (pricingOnly === "1" || justMe === "1" || access.hasHadPlan)
  );
  const pageCount = isPricingOnly ? 1 : 3;
  const pricingPage = pageCount - 1;

  const pagerRef = useRef<ScrollView>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const [page, setPage] = useState(0);
  const scrollX = useSharedValue(0);

  const [kind, setKind] = useState<PlanKind>("trip_pass");
  // Each tab remembers its own pick, so flipping back and forth keeps it.
  const [periods, setPeriods] = useState<Record<PlanKind, PlanPeriod>>({
    trip_pass: "week",
    subscription: "year",
  });
  // Already subscribed: yearly is the only way to go.
  const period = kind === "subscription" && currentSubscription ? "year" : periods[kind];
  const isSubscriptionChange = kind === "subscription" && !!currentSubscription;
  // A Trip Pass starts on the smallest group size: it's for a trip together.
  // Unless this was opened to unlock just yourself.
  const [chosenSeatCount, setSeatCount] = useState<number>(
    justMe === "1" ? JUST_ME_SEATS : GROUP_PLAN_SIZES[0]
  );
  // A renewing subscription already unlocks them on any date, so a "Just me"
  // Trip Pass would buy nothing. A cancelled one runs out, so it's still offered.
  const hidesJustMe = !!currentSubscription?.willRenew;
  const sizes = hidesJustMe ? GROUP_PLAN_SIZES : SIZES;
  const tripSeatCount =
    hidesJustMe && chosenSeatCount === JUST_ME_SEATS ? GROUP_PLAN_SIZES[0] : chosenSeatCount;
  // Subscriptions are only ever for yourself.
  const seatCount = kind === "trip_pass" ? tripSeatCount : JUST_ME_SEATS;
  const isGroupSize = seatCount > JUST_ME_SEATS;
  const [isBuying, setIsBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tabPeriods = PLAN_PERIODS.filter(
    (item) => item.kind === kind && (!isSubscriptionChange || item.key === "year")
  );
  const yearlySaving = Math.round(
    (1 - planPrice("year", seatCount) / (planPrice("month", seatCount) * 12)) * 100
  );
  const isPricingPage = page === pricingPage;
  const canContinue = !isPricingPage || !isBuying;

  // A resize (rotation, a web window) would otherwise leave the pager
  // stranded between two pages.
  useEffect(() => {
    if (pageWidth > 0) pagerRef.current?.scrollTo({ x: page * pageWidth, animated: false });
    // Only on a width change — following `page` here would fight the swipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  const goToPage = (index: number) => {
    pagerRef.current?.scrollTo({ x: index * pageWidth, animated: true });
  };

  // onScroll rather than onMomentumScrollEnd, which the web build never fires.
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = event.nativeEvent.contentOffset.x;
    scrollX.set(x);
    if (pageWidth > 0) setPage(Math.round(x / pageWidth));
  };

  // Already subscribed: upgrade a monthly one to yearly first, then (or
  // straight away, for a yearly one) open it.
  const handleSubscriptionChange = async (subscription: NonNullable<typeof currentSubscription>) => {
    let planId = subscription.id;
    if (currentSubscriptionPeriod === "month") {
      setError(null);
      setIsBuying(true);
      const result = await upgradeSubscription({
        canTestPurchase: access.canTestPurchase,
        planId: subscription.id,
        source: subscription.source,
      });
      if (result.error || result.unavailable || !result.planId) {
        setIsBuying(false);
        if (result.error) setError(result.error);
        return;
      }
      planId = result.planId;
      await refreshAccess();
      setIsBuying(false);
    }
    router.replace({ pathname: "/subscription", params: { planId } });
  };

  const handleBuy = async () => {
    if (kind === "subscription" && currentSubscription) {
      await handleSubscriptionChange(currentSubscription);
      return;
    }
    setError(null);
    setIsBuying(true);
    const result = await purchasePlan({
      canTestPurchase: access.canTestPurchase,
      period,
      seatCount,
    });
    if (result.error || result.unavailable) {
      setIsBuying(false);
      if (result.error) setError(result.error);
      return;
    }
    await refreshAccess();
    setIsBuying(false);
    if (kind === "trip_pass" && result.planId) {
      router.replace({
        pathname: "/plan-setup",
        params: { planId: result.planId, ...(groupId ? { groupId } : {}) },
      });
      return;
    }
    // A subscription starts right away, and a held entry may have been
    // waiting for exactly this.
    syncPending();
    goBackOrToGroups();
  };

  const buttonLabel =
    page === 0 && !isPricingPage
      ? "Continue"
      : !isPricingPage
        ? "See plans"
        : isBuying
        ? "Unlocking..."
        : isSubscriptionChange
          ? currentSubscriptionPeriod === "month"
            ? `Upgrade to yearly · ${priceLabel("year", JUST_ME_SEATS)}`
            : "View your subscription"
          : `${kind === "trip_pass" ? "Buy" : "Subscribe"} · ${priceLabel(period, seatCount)}`;
  const footerNote = !isPricingPage
    ? `Every group gets ${access.freeEntriesPerGroup} free entries to try it out.`
    : access.canTestPurchase
      ? "Free test purchase — nothing is charged."
      : "Viewing, settling up and deleting your own entries are always free.";

  // Each page scrolls on its own, under the floating close button.
  const renderPage = (children: ReactNode) => (
    <ScrollView
      style={{ width: pageWidth }}
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 64 }]}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.flex} onLayout={(event) => setPageWidth(event.nativeEvent.layout.width)}>
        {pageWidth > 0 ? (
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            scrollEnabled={pageCount > 1}
            showsHorizontalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
          >
            {isPricingOnly
              ? null
              : renderPage(
                  <>
                    <PageHeading
                      title="Splitting, sorted."
                      detail="One shared tab for the whole trip, fair to the cent."
                    />
                    <View style={styles.points}>
                      {SOLUTIONS.map((point) => (
                        <PointRow key={point.title} point={point} />
                      ))}
                    </View>
                  </>
                )}

            {isPricingOnly
              ? null
              : renderPage(
                  <>
                    <PageHeading
                      title="Get a Trip Pass!"
                      detail="Your group's free entries are just a taste. A Trip Pass takes the limits off for the whole trip."
                    />
                    <View style={styles.points}>
                      {TRIP_PASS_PERKS.map((point) => (
                        <PointRow key={point.title} point={point} />
                      ))}
                    </View>
                  </>
                )}

            {renderPage(
              <>
                <PageHeading
                  title={isPricingOnly ? "Get another plan" : "Choose your plan"}
                  detail={
                    isPricingOnly
                      ? "A Trip Pass for your next trip, or a subscription that keeps you unlocked."
                      : "A Trip Pass for one trip, or a subscription that keeps you unlocked."
                  }
                />

                <View style={styles.checks}>
                  {PRICING_CHECKS[kind].map((text) => (
                    <CheckRow key={text} text={text} />
                  ))}
                </View>

                <PlanTabs selected={kind} onSelect={setKind} />

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>How long</Text>
                  {/* Keyed on the tab, so the outline starts on the new tab's
                      pick instead of hopping over from a box that's gone. */}
                  <ChoiceRow
                    key={kind}
                    options={tabPeriods.map((item) => ({
                      key: item.key,
                      label: item.label,
                      detail:
                        isSubscriptionChange && currentSubscriptionPeriod === item.key
                          ? "Your plan"
                          : priceLabel(item.key, seatCount),
                    }))}
                    selected={period}
                    onSelect={(key) => setPeriods((current) => ({ ...current, [kind]: key }))}
                  />
                  {isSubscriptionChange ? (
                    <Text style={styles.hint}>
                      {currentSubscriptionPeriod === "month"
                        ? `You're on monthly. Upgrading starts a yearly subscription today that replaces it${yearlySaving > 0 ? ` — and saves ${yearlySaving}%` : ""}.`
                        : "You already have a yearly subscription, so there's nothing more to get here."}
                    </Text>
                  ) : kind === "subscription" ? (
                    <Text style={styles.hint}>
                      {yearlySaving > 0
                        ? `Renews until you cancel. Yearly saves ${yearlySaving}% compared to monthly.`
                        : "Renews until you cancel."}
                    </Text>
                  ) : null}
                </View>

                {kind === "trip_pass" ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>How many people</Text>
                    <ChoiceRow
                      options={sizes.map((size) => ({
                        key: size,
                        label: size === JUST_ME_SEATS ? "Just me" : String(size),
                        detail:
                          size === JUST_ME_SEATS
                            ? formatPrice(planPrice(period, size))
                            : `${formatPrice(planPrice(period, size) / size)} each`,
                      }))}
                      selected={seatCount}
                      onSelect={setSeatCount}
                    />
                    <Text style={styles.hint}>
                      {isGroupSize
                        ? `For up to ${seatCount} people in one group. After buying, you pick the group, when it starts and who gets a seat.`
                        : "Unlocks just you, in every group. After buying, you pick when it starts."}
                    </Text>
                  </View>
                ) : isSubscriptionChange ? null : (
                  <Text style={styles.hint}>
                    A subscription is just for you. It unlocks you in every group, starting right
                    away.
                  </Text>
                )}
              </>
            )}
          </ScrollView>
        ) : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        {pageWidth > 0 && pageCount > 1 ? (
          <View style={styles.dots}>
            {Array.from({ length: pageCount }, (_, index) => (
              <PageDot
                key={index}
                index={index}
                scrollX={scrollX}
                pageWidth={pageWidth}
                onPress={() => goToPage(index)}
              />
            ))}
          </View>
        ) : null}
        {isPricingPage && error ? <Text style={styles.error}>{error}</Text> : null}
        {/* Disabled dimming lives on a wrapper — PressableScale animates the
            button's own opacity, which would override it. */}
        <View style={!canContinue && styles.buttonDisabled}>
          <PressableScale
            style={styles.button}
            pressedScale={0.98}
            onPress={isPricingPage ? handleBuy : () => goToPage(page + 1)}
            disabled={!canContinue}
          >
            <Text style={styles.buttonText}>{buttonLabel}</Text>
          </PressableScale>
        </View>
        <Text style={styles.footerNote}>{footerNote}</Text>
      </View>

      {page > 0 ? (
        <Pressable
          style={[styles.roundButton, styles.back, { top: insets.top + 12 }]}
          onPress={() => goToPage(page - 1)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.roundButton, styles.close, { top: insets.top + 12 }]}
        onPress={goBackOrToGroups}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Ionicons name="close" size={24} color={Colors.text} />
      </Pressable>
    </View>
  );
}

const TABS_PADDING = 4;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  page: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 24,
  },
  roundButton: {
    position: "absolute",
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceSelected,
  },
  back: {
    left: 16,
  },
  close: {
    right: 16,
  },
  heading: {
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: Colors.text,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    color: Colors.muted,
  },
  points: {
    gap: 18,
  },
  point: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  pointIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.eventSurface,
  },
  pointText: {
    flex: 1,
    gap: 3,
  },
  pointTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  pointDetail: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.muted,
  },
  checks: {
    gap: 8,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  checkText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    color: Colors.text,
  },
  tabs: {
    flexDirection: "row",
    padding: TABS_PADDING,
    borderRadius: 12,
    backgroundColor: Colors.eventSurface,
    borderWidth: 1,
    borderColor: Colors.eventBorder,
  },
  tabPill: {
    position: "absolute",
    top: TABS_PADDING,
    bottom: TABS_PADDING,
    left: TABS_PADDING,
    borderRadius: 9,
    backgroundColor: Colors.accent,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.eventText,
  },
  tabLabelSelected: {
    color: Colors.accentText,
  },
  section: {
    gap: 8,
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
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  groupRowSelected: {
    borderColor: Colors.accent,
  },
  groupName: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  footer: {
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    height: 8,
    borderRadius: 4,
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
  footerNote: {
    fontSize: 12,
    color: Colors.muted,
    textAlign: "center",
  },
});
