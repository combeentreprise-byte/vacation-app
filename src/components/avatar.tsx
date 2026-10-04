import { useState } from "react";
import {
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";

import { SkeletonImage } from "@/components/skeleton";

export function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Shared by every place a member is shown (list rows, detail popups, log
// avatar stacks, the add-entry split picker): renders the real photo when the
// profile has one, falling back to initials otherwise. `style` supplies the
// circle's own size/background, which needs `overflow: "hidden"` for the
// image to actually clip to the circle. A photo shows a skeleton until it
// has loaded, and initials if it can't be loaded.
// A caller that also shows a badge on top (e.g. group/[id].tsx's AdminBadge)
// wraps this in its own unclipped wrapper rather than passing the badge in
// here — Avatar's own box clips to the circle, which would clip the badge's
// overhang too if the badge lived inside it.
export function Avatar({
  name,
  avatarUrl,
  style,
  textStyle,
}: {
  name: string;
  avatarUrl?: string | null;
  style: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <View style={style}>
      {avatarUrl && avatarUrl !== failedUrl ? (
        <SkeletonImage
          uri={avatarUrl}
          style={StyleSheet.absoluteFill}
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        <Text style={textStyle}>{getInitials(name)}</Text>
      )}
    </View>
  );
}
