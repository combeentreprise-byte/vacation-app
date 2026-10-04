import type { ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Skeleton, SkeletonGroup, SkeletonText } from "@/components/skeleton";
import { Colors } from "@/constants/colors";
import {
  GROUP_CARD_HEIGHT_RATIO,
  GROUP_HERO_HEIGHT_RATIO,
  GROUP_LIST_PADDING,
  GROUP_SUMMARY_BAR_HEIGHT,
} from "@/constants/layout";

// Loading stand-ins for whole screens and their rows, each laid out like the
// real thing (same paddings, sizes and borders) so the content drops into
// place rather than shifting the screen around. Kept beside each other here
// since several screens share them: the group list is also what the OAuth
// callback and a just-finished onboarding are on their way to.

// One of the group screen's Members tab rows (MemberRow in group/[id].tsx).
export function MemberRowSkeleton({ nameWidth = "50%" }: { nameWidth?: `${number}%` }) {
  return (
    <View style={styles.memberRow}>
      <Skeleton width={40} height={40} radius={20} />
      <View style={styles.memberNameColumn}>
        <SkeletonText fontSize={16} width={nameWidth} />
      </View>
      <View style={styles.memberDivider} />
      <View style={styles.debtColumn}>
        <SkeletonText fontSize={12} width={48} />
        <SkeletonText fontSize={14} width={64} />
      </View>
    </View>
  );
}

// One of the group screen's Logs tab expense cards (LogRow in group/[id].tsx).
export function LogRowSkeleton({
  headlineWidth = "70%",
  avatarCount = 3,
}: {
  headlineWidth?: `${number}%`;
  avatarCount?: number;
}) {
  return (
    <View style={styles.logCard}>
      <SkeletonText fontSize={16} width={headlineWidth} />
      <View style={styles.logAvatars}>
        {Array.from({ length: avatarCount }, (_, index) => (
          <View key={index} style={[styles.logAvatar, index > 0 && styles.logAvatarOverlap]}>
            <Skeleton width={18} height={18} radius={9} />
          </View>
        ))}
      </View>
    </View>
  );
}

// A bordered card with a 40px circle and a few lines of text: a plan in
// /plans (PlanRow), or a person in a plan's member list (PlanMemberRow).
export function PlanRowSkeleton({
  lines = 2,
  titleWidth = "55%",
  filled = false,
}: {
  lines?: 2 | 3;
  titleWidth?: `${number}%`;
  // A white card, like PlanMemberRow (PlanRow has none).
  filled?: boolean;
}) {
  return (
    <View style={[styles.planRow, filled && styles.filled]}>
      <Skeleton width={40} height={40} radius={20} />
      <View style={styles.planText}>
        <SkeletonText fontSize={16} width={titleWidth} />
        <SkeletonText fontSize={13} width="75%" />
        {lines === 3 ? <SkeletonText fontSize={13} width="45%" /> : null}
      </View>
    </View>
  );
}

// Varied widths, so a list of placeholders doesn't read as a striped block.
const ROW_WIDTHS: `${number}%`[] = ["50%", "38%", "60%", "44%", "54%"];

export function MemberRowsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonGroup style={styles.rows}>
      {Array.from({ length: count }, (_, index) => (
        <MemberRowSkeleton key={index} nameWidth={ROW_WIDTHS[index % ROW_WIDTHS.length]} />
      ))}
    </SkeletonGroup>
  );
}

export function LogRowsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonGroup style={styles.rows}>
      {Array.from({ length: count }, (_, index) => (
        <LogRowSkeleton
          key={index}
          headlineWidth={index % 2 === 0 ? "72%" : "58%"}
          avatarCount={(index % 3) + 1}
        />
      ))}
    </SkeletonGroup>
  );
}

// The Groups tab's card list ((tabs)/index.tsx), as many cards as fill the
// screen.
export function GroupListSkeleton() {
  const { height: windowHeight } = useWindowDimensions();
  const cardHeight = windowHeight * GROUP_CARD_HEIGHT_RATIO;
  const cardCount = Math.max(1, Math.ceil(windowHeight / (cardHeight + 12)));
  return (
    <SkeletonGroup style={styles.groupList}>
      <View style={styles.groupListHeader}>
        <SkeletonText fontSize={15} width={112} />
        <Skeleton width={24} height={24} radius={12} />
      </View>
      {Array.from({ length: cardCount }, (_, index) => (
        <View key={index} style={[styles.groupCard, { height: cardHeight }]}>
          <Skeleton radius={0} style={StyleSheet.absoluteFill} />
          <View style={styles.groupCardRibbon}>
            <SkeletonText fontSize={16} width={ROW_WIDTHS[index % ROW_WIDTHS.length]} />
          </View>
        </View>
      ))}
    </SkeletonGroup>
  );
}

// The whole group screen (group/[id].tsx) before its group is known: hero,
// title, currency, the Members/Logs switcher, a few member rows and the
// totals bar. `heroAccessory` goes over the hero, e.g. a working back
// button, so the screen can still be left while it loads.
export function GroupScreenSkeleton({ heroAccessory }: { heroAccessory?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const heroHeight = windowHeight * GROUP_HERO_HEIGHT_RATIO;
  return (
    <View style={[styles.flex, styles.filled]}>
      <SkeletonGroup style={styles.flex}>
        {/* The real hero reaches up behind the status bar the same way. */}
        <Skeleton radius={0} height={heroHeight} />
        <View style={styles.titleRow}>
          <SkeletonText fontSize={26} lineHeight={31} width="55%" />
        </View>
        <View style={styles.titleSeparator} />
        <View style={styles.detailBody}>
          <View style={styles.currencyRow}>
            <Skeleton width={20} height={14} radius={2} />
            <SkeletonText fontSize={14} width={36} />
          </View>
        </View>
        <View style={styles.segmentRow}>
          <Skeleton width={104} height={34} radius={8} />
          <Skeleton width={80} height={34} radius={8} />
        </View>
        <View style={styles.rows}>
          {ROW_WIDTHS.slice(0, 3).map((width) => (
            <MemberRowSkeleton key={width} nameWidth={width} />
          ))}
        </View>
        <View
          style={[styles.summaryBar, { height: GROUP_SUMMARY_BAR_HEIGHT + insets.bottom }]}
        >
          <SkeletonText fontSize={18} width="45%" style={styles.summaryText} />
        </View>
      </SkeletonGroup>
      {heroAccessory}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  filled: {
    backgroundColor: Colors.background,
  },
  rows: {
    padding: 20,
    gap: 12,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 12,
  },
  memberNameColumn: {
    flex: 1,
  },
  memberDivider: {
    width: 1,
    height: 28,
    backgroundColor: Colors.border,
  },
  debtColumn: {
    alignItems: "flex-end",
    minWidth: 72,
    gap: 2,
  },
  logCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 10,
  },
  logAvatars: {
    flexDirection: "row",
  },
  logAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.background,
    backgroundColor: Colors.background,
  },
  logAvatarOverlap: {
    marginLeft: -8,
  },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  planText: {
    flex: 1,
    gap: 2,
  },
  groupList: {
    padding: GROUP_LIST_PADDING,
    gap: 12,
  },
  groupListHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  groupCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  groupCardRibbon: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.background,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  titleRow: {
    paddingTop: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  titleSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
  },
  detailBody: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
  },
  currencyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  segmentRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  summaryBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  summaryText: {
    width: "100%",
    alignItems: "center",
  },
});
