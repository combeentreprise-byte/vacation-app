import { forwardRef } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  TextInput,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Colors } from "@/constants/colors";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

const PRESS_IN = { duration: 90, easing: Easing.out(Easing.quad) };
const PRESS_OUT = { duration: 180, easing: Easing.out(Easing.quad) };
const FOCUS_ANIMATION = { duration: 200, easing: Easing.inOut(Easing.quad) };

// A Pressable that visibly gives under the finger — shrinks and dims slightly
// while held, then eases back on release — so a tap registers immediately,
// before whatever it triggers has had time to show up.
export function PressableScale({
  style,
  pressedScale = 0.96,
  pressedOpacity = 0.8,
  onPressIn,
  onPressOut,
  ...props
}: Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  pressedScale?: number;
  pressedOpacity?: number;
}) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - (1 - pressedOpacity) * pressed.value,
    transform: [{ scale: 1 - (1 - pressedScale) * pressed.value }],
  }));
  return (
    <AnimatedPressable
      {...props}
      style={[style, animatedStyle]}
      onPressIn={(event) => {
        pressed.set(withTiming(1, PRESS_IN));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.set(withTiming(0, PRESS_OUT));
        onPressOut?.(event);
      }}
    />
  );
}

// A TextInput whose border fades to the accent color while it's focused, so
// it's clear which field the keyboard is typing into. Expects a style with a
// border (its resting color is taken to be Colors.border).
export const FocusTextInput = forwardRef<TextInput, TextInputProps>(function FocusTextInput(
  { style, onFocus, onBlur, ...props },
  ref
) {
  const focused = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(focused.value, [0, 1], [Colors.border, Colors.accent]),
  }));
  return (
    <AnimatedTextInput
      {...props}
      ref={ref}
      style={[style, animatedStyle]}
      onFocus={(event) => {
        focused.set(withTiming(1, FOCUS_ANIMATION));
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focused.set(withTiming(0, FOCUS_ANIMATION));
        onBlur?.(event);
      }}
    />
  );
});
