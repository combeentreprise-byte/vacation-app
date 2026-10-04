import { type ReactNode, useEffect, useState } from "react";
import {
  type DimensionValue,
  Image,
  type ImageResizeMode,
  type LayoutChangeEvent,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { Colors } from "@/constants/colors";

// Placeholder shapes shown where content is still loading — in the shape of
// what's coming, so the screen keeps its layout instead of sitting blank,
// spinning, or flashing an empty state that isn't true yet. A light band
// sweeps sideways across them (not a pulsing fade, which doesn't fit the
// app's motion).

const SWEEP_DURATION_MS = 1100;
const SWEEP_PAUSE_MS = 350;
const SWEEP_TIMING = { duration: SWEEP_DURATION_MS, easing: Easing.inOut(Easing.quad) };

// One clock for every skeleton on screen, so they all sweep in step however
// staggered their mounting was. The first one to mount starts it and the
// last one to unmount stops it.
const sweep = makeMutable(0);
let mountedCount = 0;

function useSweepClock() {
  useEffect(() => {
    mountedCount += 1;
    if (mountedCount === 1) {
      sweep.set(0);
      // Back to 0 in one jump while the band is past the right edge, so the
      // reset is never seen.
      sweep.set(
        withRepeat(
          withSequence(
            withTiming(1, SWEEP_TIMING),
            withDelay(SWEEP_PAUSE_MS, withTiming(0, { duration: 0 }))
          ),
          -1
        )
      );
    }
    return () => {
      mountedCount -= 1;
      if (mountedCount === 0) cancelAnimation(sweep);
    };
  }, []);
}

type SkeletonTone = "light" | "dark";

const TONES: Record<SkeletonTone, { base: string; highlight: string; opacity: number }> = {
  light: { base: Colors.skeleton, highlight: "#FFFFFF", opacity: 0.75 },
  // On dark backgrounds, e.g. the photo crop modal.
  dark: { base: "rgba(255, 255, 255, 0.12)", highlight: "#FFFFFF", opacity: 0.12 },
};

// One gray block. Size it like the thing it stands in for.
export function Skeleton({
  width = "100%",
  height,
  radius = 6,
  tone = "light",
  style,
}: {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  tone?: SkeletonTone;
  style?: StyleProp<ViewStyle>;
}) {
  useSweepClock();
  const blockWidth = useSharedValue(0);
  const bandStyle = useAnimatedStyle(() => {
    const band = Math.min(240, Math.max(80, blockWidth.value * 0.6));
    return {
      width: band,
      transform: [{ translateX: -band + sweep.value * (blockWidth.value + band) }],
    };
  });
  const colors = TONES[tone];
  return (
    <View
      style={[
        styles.block,
        { width, height, borderRadius: radius, backgroundColor: colors.base },
        style,
      ]}
      onLayout={(event: LayoutChangeEvent) => blockWidth.set(event.nativeEvent.layout.width)}
    >
      <Animated.View style={[styles.band, bandStyle]}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id={`skeleton-sweep-${tone}`} x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={colors.highlight} stopOpacity={0} />
              <Stop offset="0.5" stopColor={colors.highlight} stopOpacity={colors.opacity} />
              <Stop offset="1" stopColor={colors.highlight} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#skeleton-sweep-${tone})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}

// A line of text that's still loading: a bar about as tall as the glyphs,
// inside a box as tall as the real line, so swapping in the text doesn't
// shift anything around it.
export function SkeletonText({
  fontSize,
  lineHeight = Math.round(fontSize * 1.2),
  width = "60%",
  style,
}: {
  fontSize: number;
  lineHeight?: number;
  width?: DimensionValue;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ height: lineHeight, justifyContent: "center" }, style]}>
      <Skeleton width={width} height={Math.round(fontSize * 0.8)} radius={4} />
    </View>
  );
}

// Wraps a whole skeleton layout: screen readers hear one "Loading" instead
// of every placeholder, and nothing in it can be tapped.
export function SkeletonGroup({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View
      style={style}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

// A remote image with a skeleton under it until it has loaded. `onError`
// lets the caller fall back to something else (e.g. initials).
export function SkeletonImage({
  uri,
  style,
  resizeMode = "cover",
  onError,
}: {
  uri: string;
  style?: StyleProp<ViewStyle>;
  resizeMode?: ImageResizeMode;
  onError?: () => void;
}) {
  // Keyed by url, so a new picture shows its skeleton again.
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  return (
    <View style={style}>
      {loadedUri !== uri ? <Skeleton radius={0} style={StyleSheet.absoluteFill} /> : null}
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        onLoad={() => setLoadedUri(uri)}
        onError={onError}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    overflow: "hidden",
  },
  band: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
  },
});
