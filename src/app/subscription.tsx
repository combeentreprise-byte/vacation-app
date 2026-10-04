import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { type ComponentProps, type ReactNode, useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Expandable } from "@/components/expandable";
import { ConfirmationBody } from "@/components/leave-group-confirmation";
import { ModalHeader } from "@/components/modal-header";
import { PressableScale } from "@/components/press-feedback";
import { Skeleton, SkeletonGroup, SkeletonText } from "@/components/skeleton";
import { Colors } from "@/constants/colors";
import { formatPrice, planPrice, subscriptionPeriodOf } from "@/constants/plans";
import { type ActivePlan, useAccess } from "@/hooks/use-access";
import { showComingSoon } from "@/utils/coming-soon";
import { goBackOrToGroups } from "@/utils/navigation";
import { setSubscriptionRenewal, upgradeSubscription } from "@/utils/purchases";

// One running subscription of the viewer's (always "Just me", always their
// own), opened from /plans: what it costs, when it next renews, what it's
// charged to, what it's been charged so far. Up top, whichever is worth
// doing next — resuming a cancelled one, or upgrading a monthly one to
// yearly (never back) — and cancelling tucked away at the bottom.
// Store purchases don't exist yet, so the payment method is only ever the
// store account's (the app never sees the card behind it) and changing
// anything but renewal is a placeholder.

// "1 Nov 2026" — billing dates always carry their year.
function formatBillingDate(ms: number) {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const STORE_NAME = Platform.select({
  ios: "the App Store",
  android: "Google Play",
  default: "the App Store or Google Play",
});

// What it's charged to. A store subscription is billed to whatever the
// store account pays with — the app is never told which card that is.
function describePaymentMethod(plan: ActivePlan) {
  if (plan.source === "test") {
    return { title: "No payment method", detail: "Test purchases are free" };
  }
  return Platform.OS === "ios"
    ? { title: "Apple ID", detail: "Charged to the payment method on your Apple ID" }
    : Platform.OS === "android"
      ? { title: "Google Play", detail: "Charged to the payment method in your Google account" }
      : { title: "App Store or Google Play", detail: "Charged through the store you bought it in" };
}

function DetailRow({
  label,
  value,
  note,
  tone,
  isLast,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "warning";
  isLast?: boolean;
}) {
  return (
    <View style={[styles.row, !isLast && styles.rowDivider]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValueBox}>
        <Text style={[styles.rowValue, tone === "warning" && styles.warningText]}>{value}</Text>
        {note ? <Text style={styles.rowNote}>{note}</Text> : null}
      </View>
    </View>
  );
}

// The blue card up top that resuming and upgrading share, so they look the
// same and sit in the same place. `children` is shown under the button (the
// upgrade's in-place confirmation).
function PromoCard({
  icon,
  title,
  text,
  buttonIcon,
  buttonLabel,
  note,
  disabled,
  onPress,
  children,
}: {
  icon: ComponentProps<typeof Ionicons>["name"];
  title: string;
  text: string;
  buttonIcon: ComponentProps<typeof Ionicons>["name"];
  buttonLabel: string;
  note: string;
  disabled: boolean;
  onPress: () => void;
  children?: ReactNode;
}) {
  return (
    <View style={styles.promoCard}>
      <View style={styles.promoBody}>
        <View style={styles.promoHeader}>
          <View style={styles.promoIcon}>
            <Ionicons name={icon} size={22} color={Colors.accent} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.promoTitle}>{title}</Text>
            <Text style={styles.promoText}>{text}</Text>
          </View>
        </View>
        {/* Disabled dimming lives on a wrapper — PressableScale animates the
            button's own opacity, which would override it. */}
        <View style={disabled && styles.buttonDisabled}>
          <PressableScale
            style={styles.promoButton}
            pressedScale={0.97}
            onPress={onPress}
            disabled={disabled}
          >
            <Ionicons name={buttonIcon} size={18} color={Colors.accent} />
            <Text style={styles.promoButtonText}>{buttonLabel}</Text>
          </PressableScale>
        </View>
        <Text style={styles.promoNote}>{note}</Text>
      </View>
      {/* Outside the gapped body, so opening it doesn't snap a gap in. */}
      {children}
    </View>
  );
}

// Stand-in for the hero and billing details while your plans load.
function SubscriptionSkeleton() {
  return (
    <SkeletonGroup style={styles.content}>
      <View style={styles.hero}>
        <Skeleton width={48} height={48} radius={24} style={styles.heroIconSkeleton} />
        <SkeletonText fontSize={20} width="55%" style={styles.centered} />
        <SkeletonText fontSize={14} width="70%" style={styles.centered} />
        <SkeletonText fontSize={28} width="35%" style={[styles.centered, styles.heroPriceSkeleton]} />
        <Skeleton width={72} height={26} radius={13} style={styles.heroPriceSkeleton} />
      </View>
      <SkeletonText fontSize={14} width={56} style={styles.sectionTitleSkeleton} />
      <View style={styles.card}>
        {[0, 1, 2, 3].map((index) => (
          <View key={index} style={[styles.row, index < 3 && styles.rowDivider]}>
            <SkeletonText fontSize={15} width="40%" style={styles.flex} />
            <SkeletonText fontSize={15} width={88} />
          </View>
        ))}
      </View>
    </SkeletonGroup>
  );
}

export default function SubscriptionScreen() {
  const { planId } = useLocalSearchParams<{ planId: string }>();
  const { access, isLoaded, refresh } = useAccess();
  const [isConfirmingUpgrade, setIsConfirmingUpgrade] = useState(false);
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  const plan = access.activePlans.find(
    (item) => item.id === planId && item.kind === "subscription"
  );

  if (!plan) {
    return (
      <View style={styles.flex}>
        <ModalHeader title="Subscription" onClose={goBackOrToGroups} />
        {isLoaded ? (
          <View style={styles.content}>
            <Text style={styles.empty}>This subscription has ended.</Text>
          </View>
        ) : (
          <SubscriptionSkeleton />
        )}
      </View>
    );
  }

  const period = subscriptionPeriodOf(plan.durationDays);
  const price = planPrice(period, 1);
  const isTest = plan.source === "test";
  const periodName = period === "month" ? "Monthly" : "Yearly";
  // Yearly against twelve months of monthly.
  const yearlyPrice = planPrice("year", 1);
  const yearlySaving = Math.round((1 - yearlyPrice / (planPrice("month", 1) * 12)) * 100);
  const payment = describePaymentMethod(plan);
  const billingDates = [...(plan.billingDates ?? [])].reverse();

  const changeRenewal = async (willRenew: boolean) => {
    setIsBusy(true);
    const result = await setSubscriptionRenewal({
      planId: plan.id,
      source: plan.source,
      willRenew,
    });
    if (result.error) {
      Alert.alert(
        willRenew ? "Couldn't resume your subscription" : "Couldn't cancel your subscription",
        result.error
      );
    } else if (!result.unavailable) {
      setIsConfirmingCancel(false);
      await refresh();
    }
    setIsBusy(false);
  };

  // The yearly one replaces this one, so the screen moves over to it.
  const handleUpgrade = async () => {
    setIsBusy(true);
    const result = await upgradeSubscription({
      canTestPurchase: access.canTestPurchase,
      planId: plan.id,
      source: plan.source,
    });
    if (result.error) {
      Alert.alert("Couldn't upgrade your subscription", result.error);
    } else if (result.planId) {
      setIsConfirmingUpgrade(false);
      await refresh();
      router.setParams({ planId: result.planId });
    }
    setIsBusy(false);
  };

  return (
    <View style={styles.flex}>
      <ModalHeader title="Subscription" onClose={goBackOrToGroups} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="repeat" size={24} color={Colors.accent} />
          </View>
          <Text style={styles.heroTitle}>{periodName} subscription</Text>
          <Text style={styles.heroSubtitle}>Just me · unlocks entries in every group</Text>
          <Text style={styles.heroPrice}>
            {formatPrice(price)}
            <Text style={styles.heroPricePeriod}> / {period}</Text>
          </Text>
          <View style={[styles.status, plan.willRenew ? styles.statusActive : styles.statusEnding]}>
            <Text
              style={[
                styles.statusText,
                { color: plan.willRenew ? Colors.success : Colors.warning },
              ]}
            >
              {plan.willRenew ? "Active" : `Cancelled · ends ${formatBillingDate(plan.endsAt)}`}
            </Text>
          </View>
        </View>

        {isTest ? (
          <View style={styles.testNote}>
            <Ionicons name="flask-outline" size={18} color={Colors.eventText} />
            <Text style={styles.testNoteText}>
              This is a test purchase, so it&apos;s free — nothing is ever charged. It still renews
              (for free) until you cancel it.
            </Text>
          </View>
        ) : null}

        {/* The one thing worth doing next, up top: resuming a cancelled
            subscription, or upgrading a monthly one. A running yearly one
            has neither. */}
        {!plan.willRenew ? (
          <PromoCard
            icon="alarm-outline"
            title="Stay unlocked"
            text={`Your subscription ends on ${formatBillingDate(plan.endsAt)}. Resume it to keep adding entries in every group — same price, no gap.`}
            buttonIcon="refresh"
            buttonLabel="Resume subscription"
            note={`Renews on ${formatBillingDate(plan.endsAt)} for ${formatPrice(price)}${isTest ? " — free, test purchase" : ""}`}
            disabled={isBusy}
            onPress={() => changeRenewal(true)}
          />
        ) : period === "month" ? (
          <PromoCard
            icon="trending-up"
            title={`Go yearly, save ${yearlySaving}%`}
            text={`${formatPrice(yearlyPrice)} a year instead of ${formatPrice(price * 12)} — a whole year unlocked in every group, paid once a year.`}
            buttonIcon="arrow-up-circle-outline"
            buttonLabel="Upgrade to yearly"
            note={`Starts today and replaces your monthly subscription${isTest ? " — free, test purchase" : ""}`}
            disabled={isBusy}
            onPress={() => setIsConfirmingUpgrade((current) => !current)}
          >
            <Expandable open={isConfirmingUpgrade}>
              <View style={styles.promoConfirm}>
                <Text style={styles.promoText}>
                  Your yearly subscription starts today for {formatPrice(yearlyPrice)} a year
                  {isTest ? " (free — test purchase)" : ""}. You can&apos;t switch back to monthly
                  afterwards.
                </Text>
                <View style={styles.promoConfirmButtons}>
                  <Pressable
                    style={[styles.promoSecondaryButton, isBusy && styles.buttonDisabled]}
                    onPress={() => setIsConfirmingUpgrade(false)}
                    disabled={isBusy}
                  >
                    <Text style={styles.promoSecondaryButtonText}>Not now</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.promoConfirmButton, isBusy && styles.buttonDisabled]}
                    onPress={handleUpgrade}
                    disabled={isBusy}
                  >
                    <Text style={styles.promoButtonText}>Upgrade</Text>
                  </Pressable>
                </View>
              </View>
            </Expandable>
          </PromoCard>
        ) : null}

        <Text style={styles.sectionTitle}>Billing</Text>
        <View style={styles.card}>
          {plan.willRenew ? (
            <>
              <DetailRow label="Next payment" value={formatBillingDate(plan.endsAt)} />
              <DetailRow
                label="Amount"
                value={formatPrice(price)}
                note={isTest ? "Not charged — test purchase" : undefined}
              />
            </>
          ) : (
            <>
              <DetailRow label="Unlocked until" value={formatBillingDate(plan.endsAt)} />
              <DetailRow label="Renewal" value="Off" tone="warning" />
            </>
          )}
          <DetailRow label="Billing period" value={periodName} />
          <DetailRow
            label="Subscribed since"
            value={plan.startsAt !== null ? formatBillingDate(plan.startsAt) : "—"}
            isLast
          />
        </View>

        <Text style={styles.sectionTitle}>Payment method</Text>
        <View style={styles.card}>
          <View style={styles.paymentRow}>
            <View style={styles.paymentIcon}>
              <Ionicons name="card-outline" size={20} color={Colors.text} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.paymentTitle}>{payment.title}</Text>
              <Text style={styles.rowNote}>{payment.detail}</Text>
            </View>
            <Pressable
              onPress={() => showComingSoon("Changing your payment method")}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={styles.link}>Change</Text>
            </Pressable>
          </View>
        </View>

        {billingDates.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Billing history</Text>
            <View style={styles.card}>
              {billingDates.map((date, index) => (
                <View
                  key={date}
                  style={[styles.row, index < billingDates.length - 1 && styles.rowDivider]}
                >
                  <View style={styles.flex}>
                    <Text style={styles.rowValueLeft}>{formatBillingDate(date)}</Text>
                    <Text style={styles.rowNote}>
                      {periodName} subscription
                      {index === billingDates.length - 1 ? "" : " · renewal"}
                    </Text>
                  </View>
                  <Text style={styles.rowValue}>{formatPrice(isTest ? 0 : price)}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Nothing to manage once it's cancelled — resuming is up top. */}
        {plan.willRenew ? (
          <>
            <Text style={styles.sectionTitle}>Manage</Text>
            <View style={styles.card}>
              <Pressable
                style={styles.actionRow}
                onPress={() => setIsConfirmingCancel((current) => !current)}
                disabled={isBusy}
                accessibilityRole="button"
                accessibilityState={{ expanded: isConfirmingCancel }}
              >
                <Ionicons name="close-circle-outline" size={20} color={Colors.danger} />
                <Text style={[styles.actionTitle, styles.flex, styles.dangerText]}>
                  Cancel subscription
                </Text>
              </Pressable>
              <Expandable open={isConfirmingCancel}>
                <View style={styles.confirm}>
                  <ConfirmationBody
                    message={`You keep your unlock until ${formatBillingDate(plan.endsAt)}. After that it ends and ${isTest ? "won't renew" : "you won't be charged again"}. You can resume any time before then.`}
                    confirmLabel="Cancel subscription"
                    cancelLabel="Keep it"
                    destructive
                    disabled={isBusy}
                    messageInset={0}
                    buttonsInset={0}
                    onCancel={() => setIsConfirmingCancel(false)}
                    onConfirm={() => changeRenewal(false)}
                  />
                </View>
              </Expandable>
            </View>
          </>
        ) : null}

        <Text style={styles.finePrint}>
          {plan.willRenew
            ? `Renews automatically every ${period} until cancelled. ${
                isTest
                  ? "Test purchases are never charged."
                  : `Cancel at least 24 hours before ${formatBillingDate(plan.endsAt)} to avoid being charged for the next ${period}.`
              } `
            : ""}
          Subscriptions are billed and managed through {STORE_NAME}.
        </Text>

        <PressableScale
          style={styles.secondaryButton}
          pressedScale={0.98}
          onPress={() => router.push({ pathname: "/paywall", params: { pricingOnly: "1" } })}
        >
          <Text style={styles.secondaryButtonText}>See all plans</Text>
        </PressableScale>
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
    gap: 12,
  },
  empty: {
    fontSize: 15,
    color: Colors.muted,
  },
  centered: {
    width: "100%",
    alignItems: "center",
  },
  heroIconSkeleton: {
    marginBottom: 6,
  },
  heroPriceSkeleton: {
    marginTop: 8,
  },
  sectionTitleSkeleton: {
    marginTop: 8,
  },
  hero: {
    alignItems: "center",
    gap: 4,
    paddingVertical: 20,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: Colors.eventSurface,
    borderWidth: 1,
    borderColor: Colors.eventBorder,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
  },
  heroSubtitle: {
    fontSize: 14,
    color: Colors.muted,
  },
  heroPrice: {
    marginTop: 8,
    fontSize: 28,
    fontWeight: "700",
    color: Colors.text,
  },
  heroPricePeriod: {
    fontSize: 16,
    fontWeight: "500",
    color: Colors.muted,
  },
  status: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: Colors.background,
  },
  statusActive: {
    borderColor: Colors.success,
  },
  statusEnding: {
    borderColor: Colors.warning,
  },
  statusText: {
    fontSize: 13,
    fontWeight: "600",
  },
  testNote: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: Colors.eventSurface,
  },
  testNoteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.eventText,
  },
  sectionTitle: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    color: Colors.muted,
  },
  rowValueBox: {
    alignItems: "flex-end",
    flexShrink: 1,
  },
  rowValue: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  rowValueLeft: {
    fontSize: 15,
    fontWeight: "500",
    color: Colors.text,
  },
  rowNote: {
    fontSize: 13,
    color: Colors.muted,
  },
  warningText: {
    color: Colors.warning,
  },
  paymentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  paymentIcon: {
    width: 40,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  paymentTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  link: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.accent,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  actionTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  dangerText: {
    color: Colors.danger,
  },
  confirm: {
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  promoCard: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: Colors.accent,
  },
  promoBody: {
    gap: 14,
  },
  promoHeader: {
    flexDirection: "row",
    gap: 12,
  },
  promoIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  promoTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.accentText,
  },
  promoText: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 19,
    color: Colors.accentText,
  },
  promoButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: Colors.background,
  },
  promoButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.accent,
  },
  promoNote: {
    marginTop: -4,
    fontSize: 12,
    textAlign: "center",
    color: Colors.accentTextMuted,
  },
  promoConfirm: {
    gap: 12,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: Colors.accentTextMuted,
  },
  promoConfirmButtons: {
    flexDirection: "row",
    gap: 10,
  },
  promoSecondaryButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accentText,
  },
  promoSecondaryButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.accentText,
  },
  promoConfirmButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.background,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  finePrint: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.muted,
  },
  secondaryButton: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
});
