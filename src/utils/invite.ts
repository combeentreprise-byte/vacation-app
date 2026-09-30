import { Directory, File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import type { RefObject } from "react";
import { Alert, Platform, Share, type View } from "react-native";
import { captureRef } from "react-native-view-shot";

type GroupInvite = {
  groupId: string;
  groupName: string;
  inviterName: string;
  // The group's uploaded photo, if it has one — otherwise its motive is
  // captured from `motiveCardRef` (an InviteMotiveCard) instead.
  photoUrl: string | null;
  motiveCardRef: RefObject<View | null>;
};

// Characters iOS/Android won't take in a file name.
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;

// A picture of the group to attach to the invite, so the share sheet (and
// the message it sends) shows the group's photo/motive rather than the app
// icon. iOS only: React Native's Share ignores a file `url` on Android, where
// only the text goes out. iOS's share sheet shows the file's name next to the
// preview (a custom title there needs native LPLinkMetadata, which Share
// doesn't expose), so the file is named after the invite's headline. Returns
// null on any failure (offline, capture error, ...) — the invite just goes
// out as text then.
async function createInviteImage(
  { photoUrl, motiveCardRef }: GroupInvite,
  headline: string
): Promise<string | null> {
  if (Platform.OS !== "ios") return null;
  try {
    const directory = new Directory(Paths.cache, "invite");
    directory.create({ idempotent: true, intermediates: true });
    const baseName = headline.replace(UNSAFE_FILE_NAME_CHARS, "").trim() || "Invite";

    if (photoUrl) {
      const file = new File(directory, `${baseName}.jpg`);
      if (photoUrl.startsWith("file:")) {
        new File(photoUrl).copy(file, { overwrite: true });
      } else {
        await File.downloadFileAsync(photoUrl, file, { idempotent: true });
      }
      return file.uri;
    }

    if (!motiveCardRef.current) return null;
    // view-shot's own temp file gets a random name (its fileName option is
    // Android-only), hence the copy.
    const snapshotUri = await captureRef(motiveCardRef, { format: "png", result: "tmpfile" });
    const file = new File(directory, `${baseName}.png`);
    new File(snapshotUri).copy(file, { overwrite: true });
    return file.uri;
  } catch (error) {
    console.warn("Couldn't create invite image", error);
    return null;
  }
}

// The link still has to be in the message itself (not just `url`, which
// only iOS reads), so it goes on its own line under the friendly invite text.
export async function shareGroupInvite(invite: GroupInvite) {
  const { groupId, groupName, inviterName } = invite;
  const link = Linking.createURL(`join/${groupId}`);
  const inviter = inviterName.trim() || "me";
  const title = `Join ${groupName}`;
  const headline = `Come join ${inviter} on the trip to ${groupName}!`;
  const message = `${headline} ✈️\n\nTap to join the group and split expenses together:\n${link}`;
  const imageUri = await createInviteImage(invite, headline);
  try {
    await Share.share(imageUri ? { message, title, url: imageUri } : { message, title }, {
      subject: title,
      dialogTitle: "Invite to group",
    });
  } catch (error) {
    Alert.alert("Couldn't open share sheet", String(error));
  }
}
