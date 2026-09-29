import type {
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  TextInputProps,
} from "react-native";

// Caps a multiline TextInput at `maxLines` explicit line breaks (soft-wrapped
// lines don't count) by stopping the newline from ever being inserted, rather
// than stripping it back out after the fact — accepting and then reverting it
// makes the text visibly jump. Spread the result onto the TextInput in place
// of its own onChangeText.
export function useLineLimit(
  value: string,
  setValue: (text: string) => void,
  maxLines: number
): Pick<TextInputProps, "onChangeText" | "onKeyPress" | "submitBehavior"> {
  const isAtLimit = value.split("\n").length >= maxLines;
  return {
    // Last line of defense, for pasted text: a change that would go over
    // the limit is rejected outright (RN's controlled TextInput restores the
    // previous value) instead of being trimmed.
    onChangeText: (text) => {
      if (text.split("\n").length <= maxLines) setValue(text);
    },
    // Web: react-native-web runs onKeyPress before the browser's default
    // action, so preventing it here means Enter never inserts a newline.
    onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (isAtLimit && event.nativeEvent.key === "Enter") event.preventDefault();
    },
    // Native: onKeyPress fires too late to block the keystroke, but with
    // "submit" a multiline input treats Enter as submit (a no-op here, focus
    // stays) instead of inserting a newline.
    submitBehavior: isAtLimit ? "submit" : "newline",
  };
}
