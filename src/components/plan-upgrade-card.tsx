import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import {
  formatPrice,
  GROUP_PLAN_SIZES,
  PLAN_PERIODS,
  planPeriodOf,
  planPrice,
  type PlanPeriod,
} from "@/constants/plans";
import type { GroupPlan } from "@/hooks/use-group-access";
import { formatAccessDate, formatPlanEnd } from "@/utils/access";

const DAY_MS = 86_400_000;

// Overshoots its target once, slightly, and settles — a hop, not a wobble.
export const HOP_ANIMATION = { duration: 320, easing: Easing.out(Easing.back(1.4)) };

export type ChoiceOption<T> = { key: T; label: string; detail?: string };

// A row of equal boxes, one picked. The picked box's blue border is a single
// outline that hops sideways over to the next pick instead of each box
// switching its own border.
export function ChoiceRow<T extends string | number>({
  options,
  selected,
  onSelect,
}: {
  options: ChoiceOption<T>[];
  selected: T;
  onSelect: (key: T) => void;
}) {
  const [layouts, setLayouts] = useState<Record<string, { x: number; width: number }>>({});
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const isPlaced = useRef(false);

  const target = layouts[String(selected)];
  useEffect(() => {
    if (!target) return;
    if (!isPlaced.current) {
      // First placement: just be there.
      x.set(target.x);
      width.set(target.width);
      isPlaced.current = true;
      return;
    }
    if (target.x === x.get() && target.width === width.get()) return;
    x.set(withTiming(target.x, HOP_ANIMATION));
    width.set(withTiming(target.width, HOP_ANIMATION));
  }, [target, x, width]);

  const outlineStyle = useAnimatedStyle(() => ({
    width: width.value,
    transform: [{ translateX: x.value }],
  }));

  return (
    <View style={styles.choices}>
      {options.map((option) => {
        const isSelected = option.key === selected;
        return (
          <Pressable
            key={option.key}
            style={styles.choice}
            onPress={() => onSelect(option.key)}
            onLayout={(event) => {
              const { x: optionX, width: optionWidth } = event.nativeEvent.layout;
              setLayouts((current) => ({
                ...current,
                [String(option.key)]: { x: optionX, width: optionWidth },
              }));
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
          >
            <Text style={[styles.choiceLabel, isSelected && styles.choiceLabelSelected]}>
              {option.label}
            </Text>
            {option.detail ? <Text style={styles.choiceDetail}>{option.detail}</Text> : null}
          </Pressable>
        );
      })}
      {target ? (
        <Animated.View pointerEvents="none" style={[styles.choiceOutline, outlineStyle]} />
      ) : null}
    </View>
  );
}

// The group plan screen's upgrade offer: the next size up is suggested,
// keeping the end date, and a 1-week Trip Pass can also be made a 2-week
// one. Renders nothing once there's nothing left to upgrade to. Key it on the
// plan's size and end, so its picks reset after an upgrade.
export function PlanUpgradeCard({
  plan,
  canTestPurchase,
  isBusy,
  onUpgrade,
}: {
  plan: GroupPlan;
  canTestPurchase: boolean;
  isBusy: boolean;
  onUpgrade: (seatCount: number, period: PlanPeriod | null) => void;
}) {
  const currentPeriod = planPeriodOf(plan.kind, plan.startsAt, plan.endsAt);
  const canLengthen = currentPeriod?.key === "week";
  const biggerSizes: number[] = GROUP_PLAN_SIZES.filter((size) => size > plan.seatCount);
  // The current size too when only the length can change — as long as it's
  // one that's sold (not a plan that had seats added one at a time).
  const keepSize =
    canLengthen && (GROUP_PLAN_SIZES as readonly number[]).includes(plan.seatCount);
  const sizeOptions = [...(keepSize ? [plan.seatCount] : []), ...biggerSizes];

  const [seatCount, setSeatCount] = useState<number>(biggerSizes[0] ?? plan.seatCount);
  const [lengthen, setLengthen] = useState(biggerSizes.length === 0);

  if (sizeOptions.length === 0) return null;

  const lengthenedEndsAt = plan.startsAt === null ? plan.endsAt : plan.startsAt + 14 * DAY_MS;
  const targetPeriod: PlanPeriod | null = lengthen ? "two_weeks" : null;
  const endsAt = lengthen ? lengthenedEndsAt : plan.endsAt;
  const isChange = seatCount !== plan.seatCount || lengthen;
  // Only the difference between the new plan and what the current one cost,
  // rounded to whole cents (the subtraction can leave float dust).
  const price = currentPeriod
    ? Math.max(
        Math.round(
          (planPrice(targetPeriod ?? currentPeriod.key, seatCount) -
            planPrice(currentPeriod.key, plan.seatCount)) *
            100
        ) / 100,
        0
      )
    : null;
  const perTerm =
    currentPeriod?.kind === "subscription"
      ? currentPeriod.key === "year"
        ? " / year"
        : " / month"
      : "";
  const twoWeeks = PLAN_PERIODS.find((item) => item.key === "two_weeks");

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Upgrade plan</Text>
        <Text style={styles.summary}>
          Up to {seatCount} people,{" "}
          {formatPlanEnd(
            endsAt,
            plan.willRenew,
            lengthen ? 14 : plan.durationDays,
            `${plan.willRenew ? "renews" : "until"} ${formatAccessDate(endsAt)}`
          )}
        </Text>
      </View>

      <View style={styles.group}>
        <Text style={styles.groupLabel}>People</Text>
        <ChoiceRow
          options={sizeOptions.map((size) => ({ key: size, label: `Up to ${size}` }))}
          selected={seatCount}
          onSelect={setSeatCount}
        />
      </View>

      {canLengthen ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Length</Text>
          <ChoiceRow
            options={[
              { key: "keep", label: "1 week", detail: `Until ${formatAccessDate(plan.endsAt)}` },
              {
                key: "lengthen",
                label: twoWeeks?.label ?? "2 weeks",
                detail: `Until ${formatAccessDate(lengthenedEndsAt)}`,
              },
            ]}
            selected={lengthen ? "lengthen" : "keep"}
            onSelect={(key) => setLengthen(key === "lengthen")}
          />
        </View>
      ) : null}

      {/* Disabled dimming lives on a wrapper — PressableScale animates the
          button's own opacity, which would override it. */}
      <View style={(isBusy || !isChange) && styles.buttonDisabled}>
        <PressableScale
          style={styles.button}
          pressedScale={0.98}
          onPress={() => onUpgrade(seatCount, targetPeriod)}
          disabled={isBusy || !isChange}
        >
          <Text style={styles.buttonText}>
            {isBusy
              ? "Upgrading..."
              : !isChange
                ? "Your current plan"
                : price !== null
                  ? `Upgrade · ${formatPrice(price)}${perTerm}`
                  : "Upgrade"}
          </Text>
        </PressableScale>
      </View>
      {canTestPurchase ? (
        <Text style={styles.hint}>Free test purchase — nothing is charged.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 14,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.eventBorder,
    backgroundColor: Colors.eventSurface,
  },
  header: {
    gap: 2,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  summary: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.muted,
  },
  group: {
    gap: 8,
  },
  groupLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.text,
  },
  choices: {
    flexDirection: "row",
    gap: 8,
  },
  choice: {
    flex: 1,
    gap: 2,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceOutline: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.accent,
  },
  choiceLabel: {
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  choiceLabelSelected: {
    color: Colors.accent,
  },
  choiceDetail: {
    textAlign: "center",
    fontSize: 12,
    color: Colors.muted,
  },
  button: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  hint: {
    fontSize: 12,
    color: Colors.muted,
    textAlign: "center",
  },
});
