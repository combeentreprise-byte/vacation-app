import AsyncStorage from "@react-native-async-storage/async-storage";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

// On-device copies of server data (so the app opens with something to show
// when there's no connection) and queues of changes still waiting to reach
// the server. Everything tied to an account lives under that user's own
// prefix, so another account signing in on the same device never sees it and
// signing out can wipe exactly that user's data (see clearOfflineDataForUser).
const PREFIX = "offline:";

function userKey(userId: string, name: string) {
  return `${PREFIX}${userId}:${name}`;
}

async function read<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch (error) {
    console.warn("Failed to read offline data", key, error);
    return null;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("Failed to write offline data", key, error);
  }
}

export function readUserData<T>(userId: string, name: string): Promise<T | null> {
  return read<T>(userKey(userId, name));
}

export function writeUserData(userId: string, name: string, value: unknown): Promise<void> {
  return write(userKey(userId, name), value);
}

// For data that isn't anyone's in particular (e.g. exchange rates).
export function readSharedData<T>(name: string): Promise<T | null> {
  return read<T>(`${PREFIX}shared:${name}`);
}

export function writeSharedData(name: string, value: unknown): Promise<void> {
  return write(`${PREFIX}shared:${name}`, value);
}

// Where a user's not-yet-uploaded files (e.g. a profile picture picked
// offline) are kept on native. The picker's own output lives in a cache
// directory the OS may clear, so anything queued is copied here first.
export function userFilesDirectory(userId: string): Directory {
  const directory = new Directory(Paths.document, "offline", userId);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

// Same idea as userFilesDirectory, for pictures picked during onboarding —
// before there's an account (and so a user id) to file them under.
export function onboardingFilesDirectory(): Directory {
  const directory = new Directory(Paths.document, "offline", "onboarding");
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

// A picked image kept somewhere it'll still be when it's finally uploaded:
// a file:// copy on native (the picker's own output sits in a cache
// directory the OS may clear), a data: URL on web, which has no file system
// to keep it in. Either one displays as-is.
export type StoredImage = {
  uri: string;
  contentType: string;
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// `directory` is only called on native, since web has no file system to
// create it in.
export async function storePickedImage(
  pickedUri: string,
  directory: () => Directory,
  fileName: string
): Promise<StoredImage> {
  if (Platform.OS === "web") {
    const blob = await (await fetch(pickedUri)).blob();
    return { uri: await blobToDataUrl(blob), contentType: blob.type || "image/jpeg" };
  }
  const copy = new File(directory(), fileName);
  await new File(pickedUri).copy(copy);
  return { uri: copy.uri, contentType: "image/jpeg" };
}

export async function readStoredImage(image: StoredImage): Promise<Blob | ArrayBuffer> {
  if (Platform.OS === "web") return (await fetch(image.uri)).blob();
  return decodeBase64(await new File(image.uri).base64());
}

export function deleteStoredImage(image: StoredImage) {
  if (Platform.OS === "web") return;
  try {
    const file = new File(image.uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("Failed to delete stored image", error);
  }
}

export async function clearOfflineDataForUser(userId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((key) => key.startsWith(`${PREFIX}${userId}:`)));
  } catch (error) {
    console.warn("Failed to clear offline data", error);
  }

  if (Platform.OS !== "web") {
    try {
      const directory = new Directory(Paths.document, "offline", userId);
      if (directory.exists) directory.delete();
    } catch (error) {
      console.warn("Failed to clear offline files", error);
    }
  }
}
