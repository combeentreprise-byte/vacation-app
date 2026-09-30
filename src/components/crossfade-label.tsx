import { useEffect } from "react";
import { type StyleProp, StyleSheet, type TextStyle, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

export const CROSSFADE_ANIMATION = { duration: 320, easing: Easing.inOut(Easing.quad) };

// A text label that crossfades between two strings (e.g. "Select all" /
// "Deselect all") instead of swapping instantly. Both strings stay mounted and
// stacked — the longer one sits in the layout so the label's size (and its
// tap target) never jumps mid-fade; the shorter one overlays it, pinned to
// `align`'s edge.
export function CrossfadeLabel({
  first,
  second,
  showSecond,
  align = "left",
  style,
}: {
  first: string;
  second: string;
  showSecond: boolean;
  align?: "left" | "right";
  style?: StyleProp<TextStyle>;
}) {
  const progress = useSharedValue(showSecond ? 1 : 0);
  useEffect(() => {
    progress.set(withTiming(showSecond ? 1 : 0, CROSSFADE_ANIMATION));
  }, [showSecond, progress]);
  const firstStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const secondStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  const firstIsLonger = first.length >= second.length;
  const overlayStyle = [styles.overlay, align === "left" ? styles.alignLeft : styles.alignRight];
  return (
    <View accessible accessibilityLabel={showSecond ? second : first}>
      <Animated.Text
        style={[style, firstStyle, !firstIsLonger && overlayStyle]}
        numberOfLines={1}
        importantForAccessibility="no"
      >
        {first}
      </Animated.Text>
      <Animated.Text
        style={[style, secondStyle, firstIsLonger && overlayStyle]}
        numberOfLines={1}
        importantForAccessibility="no"
      >
        {second}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
  },
  alignLeft: {
    left: 0,
  },
  alignRight: {
    right: 0,
  },
});
