import { type ReactNode, useEffect, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

export const EXPAND_DURATION_MS = 260;
export const EXPAND_ANIMATION = { duration: EXPAND_DURATION_MS, easing: Easing.inOut(Easing.quad) };

// Content that opens by growing to its natural height and closes by
// shrinking away (clipped, no fade), pushing whatever sits below it along
// smoothly. Stays mounted through the closing animation, so pass the same
// children while `open` goes false.
export function Expandable({ open, children }: { open: boolean; children: ReactNode }) {
  const [isMounted, setIsMounted] = useState(open);
  // Adjusted during render (not in an effect) so opening never paints a
  // frame without its content.
  if (open && !isMounted) setIsMounted(true);

  const progress = useSharedValue(open ? 1 : 0);
  const naturalHeight = useSharedValue(0);
  useEffect(() => {
    progress.set(withTiming(open ? 1 : 0, EXPAND_ANIMATION));
    if (open) return;
    const timeout = setTimeout(() => setIsMounted(false), EXPAND_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [open, progress]);

  // The content is absolutely positioned inside the animated wrapper, so its
  // measured height never depends on the height it drives (on native that
  // feedback loop makes the layout jitter — see GroupActionsMenu).
  const onContentLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) naturalHeight.set(height);
  };
  const wrapperStyle = useAnimatedStyle(() => ({
    height: naturalHeight.value * progress.value,
  }));

  if (!isMounted) return null;
  return (
    <Animated.View style={[styles.wrapper, wrapperStyle]} pointerEvents={open ? "auto" : "none"}>
      <View style={styles.content} onLayout={onContentLayout}>
        {children}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: "hidden",
  },
  content: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
});
