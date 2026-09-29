import { decode as decodeBase64 } from "base64-arraybuffer";
import { File } from "expo-file-system";
import { Platform } from "react-native";

import { supabase } from "@/lib/supabase";

// Uploads a locally picked group photo (a picker/crop result, or a copy kept
// on the device during onboarding) and returns its public URL. Throws on
// failure.
export async function uploadGroupPhoto(userId: string, uri: string): Promise<string> {
  // Always a fresh key (unlike the avatar's fixed "{user_id}/avatar" slot)
  // since one user creates many groups — nothing to overwrite, so no upsert
  // needed.
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let contentType = "image/jpeg";
  let fileData: Blob | ArrayBuffer;
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    contentType = blob.type || contentType;
    fileData = blob;
  } else {
    fileData = decodeBase64(await new File(uri).base64());
  }

  const { error } = await supabase.storage
    .from("group-photos")
    .upload(path, fileData, { contentType });
  if (error) throw error;

  return supabase.storage.from("group-photos").getPublicUrl(path).data.publicUrl;
}
