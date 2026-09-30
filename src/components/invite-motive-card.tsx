import type { RefObject } from "react";
import { StyleSheet, View } from "react-native";

import { GroupHero } from "@/components/hero-motive";

type InviteMotiveCardProps = {
  ref: RefObject<View | null>;
  motive: string;
  hue: number;
};

// The group's motive at a fixed card size, existing only to be captured as
// the invite's preview image (see shareGroupInvite in utils/invite.ts). The
// screen renders it behind its own content: it has to be really laid out and
// drawn to be captured (an off-screen or transparent view snapshots blank on
// iOS), but nobody needs to see it. Captured at the device's pixel ratio, so
// the image comes out ~3x this size.
export function InviteMotiveCard({ ref, motive, hue }: InviteMotiveCardProps) {
  return (
    <View ref={ref} collapsable={false} pointerEvents="none" style={styles.card}>
      <GroupHero photoUrl={null} motive={motive} hue={hue} fill="80%" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 320,
    height: 240,
  },
});
