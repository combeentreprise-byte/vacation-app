import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

// The one-shot motion an icon plays when its tab becomes active (see
// `TabIcon` in tab-bar.tsx).
export type TabIconAnimation = "hop" | "wiggle" | "spin";

export type TabConfig = {
  name: string;
  href: "/" | "/scan" | "/account";
  title: string;
  label: string;
  icon: IoniconName;
  iconActive: IoniconName;
  animation: TabIconAnimation;
};

export const TABS: TabConfig[] = [
  {
    name: "index",
    href: "/",
    title: "Group",
    label: "Group",
    icon: "people-outline",
    iconActive: "people",
    animation: "hop",
  },
  {
    name: "scan",
    href: "/scan",
    title: "Scan",
    label: "Scan",
    icon: "receipt-outline",
    iconActive: "receipt",
    animation: "wiggle",
  },
  {
    name: "account",
    href: "/account",
    title: "Account Settings",
    label: "Account",
    icon: "settings-outline",
    iconActive: "settings",
    animation: "spin",
  },
];
