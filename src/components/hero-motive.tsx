import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

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
        preserveAspectRatio={PRESERVE_ASPECT_RATIO[verticalAlign]}
      />
    </View>
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
export function GroupHero({ photoUrl, motive, hue, style, fill, verticalAlign }: GroupHeroProps) {
  if (!photoUrl) {
    return (
      <HeroMotive motive={motive} hue={hue} style={style} fill={fill} verticalAlign={verticalAlign} />
    );
  }
  return (
    <View style={[styles.container, style]}>
      <Image source={{ uri: photoUrl }} style={styles.photoFill} resizeMode="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  photoFill: {
    width: "100%",
    height: "100%",
  },
});
