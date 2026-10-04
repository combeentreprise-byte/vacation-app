import { memo, useEffect, useRef, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { SkeletonImage } from "@/components/skeleton";
import { resolveHeroMotiveVariant } from "@/utils/hero-motive";

// Motive artwork fills most of its container rather than sitting at a fixed
// pixel size — each motive has its own natural aspect ratio (a wide skyline
// vs. a squarer icon), and a percentage width/height plus the SVG's own
// preserveAspectRatio="meet" scales any of them consistently without this
// component needing to know each one's proportions.
const DEFAULT_MOTIVE_FILL = "85%";

type VerticalAlign = "top" | "center" | "bottom";

// Two levers have to move together to actually shift the artwork: the outer
// View's justifyContent (positions the SVG's own box within the container)
// and the SVG's preserveAspectRatio Y-alignment (positions the artwork
// within its *own* box, since `fill` rarely divides evenly into the SVG's
// aspect ratio and leaves letterboxing inside that box too). Bias only the
// outer one and most motives barely move — their own internal letterboxing
// re-centers them.
const JUSTIFY_CONTENT: Record<VerticalAlign, ViewStyle["justifyContent"]> = {
  top: "flex-start",
  center: "center",
  bottom: "flex-end",
};

const PRESERVE_ASPECT_RATIO: Record<VerticalAlign, string> = {
  top: "xMidYMin meet",
  center: "xMidYMid meet",
  bottom: "xMidYMax meet",
};

type HeroMotiveProps = {
  motive: string;
  hue: number;
  style?: StyleProp<ViewStyle>;
  // Overrides how much of the container the artwork fills (see
  // DEFAULT_MOTIVE_FILL) — the group detail hero is tall/wide enough that
  // the default reading looks small, so it asks for more.
  fill?: `${number}%`;
  // Where the artwork sits within its container — defaults to dead center.
  verticalAlign?: VerticalAlign;
};

// Placeholder for a group's photo (see hero-motive.ts) — used by the group
// list's cards, the group detail screen's hero, and the create-group
// preview, so a real <Image> can drop in ahead of this once groups have
// photos, without any call site needing to know about motives/colors itself.
export function HeroMotive({
  motive,
  hue,
  style,
  fill = DEFAULT_MOTIVE_FILL,
  verticalAlign = "center",
}: HeroMotiveProps) {
  const { Motive, background, line } = resolveHeroMotiveVariant(motive, hue);
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: background, justifyContent: JUSTIFY_CONTENT[verticalAlign] },
        style,
      ]}
    >
      <Motive
        width={fill}
        height={fill}
        color={line}
        holeColor={background}
        preserveAspectRatio={PRESERVE_ASPECT_RATIO[verticalAlign]}
      />
    </View>
  );
}

const POP_OUT = { duration: 140, easing: Easing.in(Easing.quad) };
const POP_OVERSHOOT = 1.06;
const POP_GROW = { duration: 170, easing: Easing.out(Easing.quad) };
const POP_SETTLE = { duration: 150, easing: Easing.inOut(Easing.quad) };
const POP_BACKGROUND = { duration: 260, easing: Easing.inOut(Easing.quad) };

const TRANSFORM_ORIGIN: Record<VerticalAlign, string> = {
  top: "center top",
  center: "center",
  bottom: "center bottom",
};

// A HeroMotive that "pops" between motives instead of swapping instantly
// (the create/edit group form's shuffle button): the current artwork shrinks
// away, the background color slides to the new hue, and the new artwork
// grows back in with a single slight overshoot. The swap itself waits for
// the shrink to actually finish, so a new motive is never shown mid-shrink —
// and shuffling again mid-pop just restarts the shrink from wherever it is.
export function PopHeroMotive({
  motive,
  hue,
  style,
  fill = DEFAULT_MOTIVE_FILL,
  verticalAlign = "center",
}: HeroMotiveProps) {
  const [shown, setShown] = useState({ motive, hue });
  const { Motive, background, line } = resolveHeroMotiveVariant(shown.motive, shown.hue);
  const targetBackground = resolveHeroMotiveVariant(motive, hue).background;

  const scale = useSharedValue(1);
  const backgroundColor = useSharedValue(background);

  useEffect(() => {
    if (motive === shown.motive && hue === shown.hue) return;
    backgroundColor.set(withTiming(targetBackground, POP_BACKGROUND));
    scale.set(
      withTiming(0, POP_OUT, (finished) => {
        if (finished) scheduleOnRN(setShown, { motive, hue });
      })
    );
  }, [motive, hue, shown, targetBackground, scale, backgroundColor]);

  // Grows the new artwork back in once it has actually been swapped in —
  // skipped on mount so the first motive just appears.
  const hasMounted = useRef(false);
  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    scale.set(
      withSequence(withTiming(POP_OVERSHOOT, POP_GROW), withTiming(1, POP_SETTLE))
    );
  }, [shown, scale]);

  const containerStyle = useAnimatedStyle(() => ({ backgroundColor: backgroundColor.value }));
  const artworkStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[styles.container, style, containerStyle]}>
      <Animated.View
        style={[
          styles.popArtwork,
          { justifyContent: JUSTIFY_CONTENT[verticalAlign], transformOrigin: TRANSFORM_ORIGIN[verticalAlign] },
          artworkStyle,
        ]}
      >
        <Motive
          width={fill}
          height={fill}
          color={line}
          holeColor={background}
          preserveAspectRatio={PRESERVE_ASPECT_RATIO[verticalAlign]}
        />
      </Animated.View>
    </Animated.View>
  );
}

type GroupHeroProps = {
  photoUrl: string | null;
  motive: string;
  hue: number;
  style?: StyleProp<ViewStyle>;
  fill?: `${number}%`;
  verticalAlign?: VerticalAlign;
};

// The actual public API for rendering a group's hero: a real photo when the
// group has one, falling back to its placeholder motive otherwise. `fill`/
// `verticalAlign` only mean something for the motive illustration's own
// letterboxing — a photo always covers its container edge-to-edge — so
// they're passed through to HeroMotive alone rather than used here too.
// Memoized so a parent re-render that doesn't touch these props (e.g. the
// group list toggling "Manage groups") skips re-rendering the SVG subtree —
// the traced motives are heavy enough that re-rendering one per card shows.
export const GroupHero = memo(function GroupHero({
  photoUrl,
  motive,
  hue,
  style,
  fill,
  verticalAlign,
}: GroupHeroProps) {
  if (!photoUrl) {
    return (
      <HeroMotive motive={motive} hue={hue} style={style} fill={fill} verticalAlign={verticalAlign} />
    );
  }
  return (
    <View style={[styles.container, style]}>
      <SkeletonImage uri={photoUrl} style={styles.photoFill} />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  popArtwork: {
    width: "100%",
    height: "100%",
    alignItems: "center",
  },
  photoFill: {
    width: "100%",
    height: "100%",
  },
});
