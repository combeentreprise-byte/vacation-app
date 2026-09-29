import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";

export const ONBOARDING_STEP_COUNT = 3;

type OnboardingHeaderProps = {
  // 1-based.
  step: number;
  onBack?: () => void;
  action?: { label: string; onPress: () => void };
};

// Top bar for the app/onboarding/ steps: back, a dot per step, and an
// optional text action on the right (the group step's "Skip").
export function OnboardingHeader({ step, onBack, action }: OnboardingHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      <View style={styles.side}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={24} color={Colors.text} />
          </Pressable>
        ) : null}
      </View>

      <View
        style={styles.dots}
        accessibilityLabel={`Step ${step} of ${ONBOARDING_STEP_COUNT}`}
      >
        {Array.from({ length: ONBOARDING_STEP_COUNT }, (_, index) => (
          <View key={index} style={[styles.dot, index < step && styles.dotDone]} />
        ))}
      </View>

      <View style={[styles.side, styles.sideRight]}>
        {action ? (
          <Pressable onPress={action.onPress} hitSlop={12} accessibilityRole="button">
            <Text style={styles.actionText}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: Colors.background,
  },
  // Equal-width sides keep the dots centered whether or not either side has
  // anything in it.
  side: {
    width: 60,
  },
  sideRight: {
    alignItems: "flex-end",
  },
  dots: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  dot: {
    width: 28,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
  },
  dotDone: {
    backgroundColor: Colors.accent,
  },
  actionText: {
    fontSize: 16,
    fontWeight: "500",
    color: Colors.accent,
  },
});
