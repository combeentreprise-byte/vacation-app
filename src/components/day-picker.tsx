import { Ionicons } from "@expo/vector-icons";
import { useLayoutEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Colors } from "@/constants/colors";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// Midnight, local time, at the start of `ms`'s day.
export function startOfDay(ms: number) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// "1 October 2026"
export function formatLongDay(day: number) {
  return new Date(day).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function addDays(day: number, count: number) {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count).getTime();
}

// Sideways only, no overshoot: text that hops past its spot reads as a
// glitch, unlike ChoiceRow's outline.
const SLIDE_ANIMATION = { duration: 260, easing: Easing.out(Easing.cubic) };

// The picked day, shown above the calendar in a box like a picked ChoiceRow
// option, with arrows to move it a day at a time. When it changes, the new
// date slides in sideways from the side it moved to (later from the right)
// as the old one slides out the other way.
export function DayField({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (day: number) => void;
}) {
  const [shown, setShown] = useState<{ current: number; previous: number | null }>({
    current: value,
    previous: null,
  });
  if (value !== shown.current) setShown({ current: value, previous: shown.current });
  const [width, setWidth] = useState(0);
  const progress = useSharedValue(1);
  const direction = useSharedValue(1);

  // Before paint, so the new date never flashes in place first.
  useLayoutEffect(() => {
    if (shown.previous === null) return;
    direction.set(shown.current > shown.previous ? 1 : -1);
    progress.set(0);
    progress.set(withTiming(1, SLIDE_ANIMATION));
  }, [shown, direction, progress]);

  const incomingStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: direction.value * width * (1 - progress.value) }],
  }));
  const outgoingStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -direction.value * width * progress.value }],
  }));

  const canGoBack = value > min;
  const canGoForward = value < max;

  return (
    <View style={styles.field}>
      <Pressable
        onPress={() => onChange(addDays(value, -1))}
        disabled={!canGoBack}
        hitSlop={10}
        style={styles.fieldArrow}
        accessibilityLabel="Day before"
      >
        <Ionicons name="chevron-back" size={20} color={canGoBack ? Colors.accent : Colors.border} />
      </Pressable>
      <View
        style={styles.fieldWindow}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessibilityLiveRegion="polite"
      >
        {shown.previous !== null ? (
          <Animated.Text style={[styles.fieldText, styles.fieldTextOutgoing, outgoingStyle]}>
            {formatLongDay(shown.previous)}
          </Animated.Text>
        ) : null}
        <Animated.Text style={[styles.fieldText, incomingStyle]}>
          {formatLongDay(shown.current)}
        </Animated.Text>
      </View>
      <Pressable
        onPress={() => onChange(addDays(value, 1))}
        disabled={!canGoForward}
        hitSlop={10}
        style={styles.fieldArrow}
        accessibilityLabel="Day after"
      >
        <Ionicons
          name="chevron-forward"
          size={20}
          color={canGoForward ? Colors.accent : Colors.border}
        />
      </Pressable>
    </View>
  );
}

function addMonths(year: number, month: number, count: number) {
  const date = new Date(year, month + count, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

// A month calendar for picking one day between `min` and `max` (both local
// midnights). Weeks start on Monday. `value` is the picked day's midnight, or
// null for none.
export function DayPicker({
  value,
  min,
  max,
  onChange,
}: {
  value: number | null;
  min: number;
  max: number;
  onChange: (day: number) => void;
}) {
  const initial = new Date(value ?? min);
  const [shown, setShown] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  // A day picked from outside (DayField's arrows) brings its month into
  // view.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (value !== null) {
      const date = new Date(value);
      setShown({ year: date.getFullYear(), month: date.getMonth() });
    }
  }
  const first = new Date(shown.year, shown.month, 1);
  const daysInMonth = new Date(shown.year, shown.month + 1, 0).getDate();
  // Monday-first: getDay() is 0 for Sunday.
  const leadingBlanks = (first.getDay() + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) =>
      new Date(shown.year, shown.month, index + 1).getTime()
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) =>
    cells.slice(index * 7, index * 7 + 7)
  );

  const previous = addMonths(shown.year, shown.month, -1);
  const next = addMonths(shown.year, shown.month, 1);
  const canGoBack = new Date(previous.year, previous.month + 1, 0).getTime() >= min;
  const canGoForward = new Date(next.year, next.month, 1).getTime() <= max;
  const title = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <View style={styles.calendar}>
      <View style={styles.header}>
        <Pressable
          onPress={() => setShown(previous)}
          disabled={!canGoBack}
          hitSlop={10}
          accessibilityLabel="Previous month"
        >
          <Ionicons name="chevron-back" size={20} color={canGoBack ? Colors.text : Colors.border} />
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <Pressable
          onPress={() => setShown(next)}
          disabled={!canGoForward}
          hitSlop={10}
          accessibilityLabel="Next month"
        >
          <Ionicons
            name="chevron-forward"
            size={20}
            color={canGoForward ? Colors.text : Colors.border}
          />
        </Pressable>
      </View>
      <View style={styles.week}>
        {WEEKDAYS.map((day) => (
          <Text key={day} style={[styles.cell, styles.weekday]}>
            {day}
          </Text>
        ))}
      </View>
      {weeks.map((week, weekIndex) => (
        <View key={weekIndex} style={styles.week}>
          {week.map((day, dayIndex) => {
            if (day === null) return <View key={dayIndex} style={styles.cell} />;
            const isEnabled = day >= min && day <= max;
            const isSelected = day === value;
            return (
              <Pressable
                key={dayIndex}
                style={styles.cell}
                onPress={() => onChange(day)}
                disabled={!isEnabled}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected, disabled: !isEnabled }}
                accessibilityLabel={new Date(day).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                })}
              >
                <View style={[styles.dayCircle, isSelected && styles.dayCircleSelected]}>
                  <Text
                    style={[
                      styles.dayText,
                      !isEnabled && styles.dayTextDisabled,
                      isSelected && styles.dayTextSelected,
                    ]}
                  >
                    {new Date(day).getDate()}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Looks like a picked ChoiceRow box (plan-upgrade-card.tsx).
  field: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 2,
    borderColor: Colors.accent,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: Colors.background,
  },
  fieldArrow: {
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  fieldWindow: {
    flex: 1,
    overflow: "hidden",
  },
  fieldText: {
    paddingVertical: 10,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: Colors.accent,
  },
  fieldTextOutgoing: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  calendar: {
    gap: 4,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  week: {
    flexDirection: "row",
  },
  cell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 2,
  },
  weekday: {
    fontSize: 12,
    color: Colors.muted,
    textAlign: "center",
  },
  dayCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  dayCircleSelected: {
    backgroundColor: Colors.accent,
  },
  dayText: {
    fontSize: 15,
    color: Colors.text,
  },
  dayTextDisabled: {
    color: Colors.border,
  },
  dayTextSelected: {
    color: Colors.accentText,
    fontWeight: "600",
  },
});
