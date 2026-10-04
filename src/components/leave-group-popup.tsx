import { useState } from "react";
import { Animated, Dimensions, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import {
  LEAVE_CONFIRMATION_PADDING_X,
  LEAVE_CONFIRMATION_WIDTH,
  LeaveGroupConfirmationBody,
  leaveConfirmationTitle,
} from "@/components/leave-group-confirmation";
import type { MenuAnchor } from "@/components/menu-anchor";
import { Colors } from "@/constants/colors";
import { popupScaleStyle, usePopupAnimation } from "@/hooks/use-popup-animation";

const SCREEN_MARGIN = 12;
// Gap between the tapped icon and the popup's left edge.
const ANCHOR_GAP_X = 20;
// How far above the tapped point the popup's top sits, so the title lines up
// roughly with the icon it came from.
const TITLE_OFFSET_Y = 26;

export type LeaveGroupRequest = {
  anchor: MenuAnchor;
  isLastMember: boolean;
  isSponsor: boolean;
  // See LeaveGroupConfirmationBody.
  seatStartsAt: number | null;
};

// The group list's leave confirmation: a popup that opens just to the right
// of the tapped leave icon, over the group's card. Same content as the
// confirmation GroupActionsMenu morphs into on the group screen (see
// leave-group-confirmation.tsx), just without a menu to morph from.
export function LeaveGroupPopup({
  request,
  onClose,
  onConfirm,
}: {
  request: LeaveGroupRequest | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { isMounted, progress } = usePopupAnimation(!!request);
  // Kept while request is null so the popup keeps its position and copy
  // while it animates closed (see usePopupAnimation), set during render per
  // React's documented pattern for adjusting state in response to a prop.
  const [displayRequest, setDisplayRequest] = useState(request);
  if (request && request !== displayRequest) {
    setDisplayRequest(request);
  }

  // Measured so a popup opened from a card near the bottom of the screen can
  // be nudged up to stay fully visible. The popup's height doesn't depend on
  // where it's placed, so this can't feed back into itself.
  const [boxHeight, setBoxHeight] = useState(0);

  const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
  const anchor = displayRequest?.anchor;
  const left = anchor
    ? Math.min(
        Math.max(SCREEN_MARGIN, anchor.x + ANCHOR_GAP_X),
        screenWidth - LEAVE_CONFIRMATION_WIDTH - SCREEN_MARGIN
      )
    : 0;
  const top = anchor
    ? Math.max(
        SCREEN_MARGIN,
        Math.min(anchor.y - TITLE_OFFSET_Y, screenHeight - boxHeight - SCREEN_MARGIN)
      )
    : 0;

  return (
    <Modal transparent visible={isMounted} animationType="none" onRequestClose={onClose}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}
      />
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        {displayRequest ? (
          <Animated.View
            // Swallows taps on the box itself (e.g. on the message text) so
            // they don't fall through to the backdrop and close it.
            onStartShouldSetResponder={() => true}
            onLayout={(event) => setBoxHeight(event.nativeEvent.layout.height)}
            style={[styles.box, { top, left }, popupScaleStyle(progress)]}
          >
            <View style={styles.titleRow}>
              <Text style={styles.title}>{leaveConfirmationTitle(displayRequest.isLastMember)}</Text>
            </View>
            <LeaveGroupConfirmationBody
              isLastMember={displayRequest.isLastMember}
              isSponsor={displayRequest.isSponsor}
              seatStartsAt={displayRequest.seatStartsAt}
              onCancel={onClose}
              onConfirm={onConfirm}
            />
          </Animated.View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // A light dim (the member/log detail popups use a heavier one) so the
  // popup lifts off same-colored content behind it while still reading as
  // attached to the button it came from.
  backdrop: {
    backgroundColor: "rgba(17, 24, 28, 0.18)",
  },
  // Matches GroupActionsMenu's box, so both leave confirmations look alike.
  box: {
    position: "absolute",
    width: LEAVE_CONFIRMATION_WIDTH,
    paddingVertical: 6,
    backgroundColor: Colors.background,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 14,
    // Grows out from the side facing the icon it was opened from.
    transformOrigin: "top left",
  },
  titleRow: {
    paddingVertical: 12,
    paddingHorizontal: LEAVE_CONFIRMATION_PADDING_X,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.text,
  },
});
