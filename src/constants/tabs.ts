import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

export type TabConfig = {
  name: string;
  href: "/" | "/scan" | "/account";
  title: string;
  label: string;
  icon: IoniconName;
  iconActive: IoniconName;
};

export const TABS: TabConfig[] = [
  {
    name: "index",
    href: "/",
    title: "Group",
    label: "Group",
    icon: "people-outline",
    iconActive: "people",
  },
  {
    name: "scan",
    href: "/scan",
    title: "Scan",
    label: "Scan",
    icon: "camera-outline",
    iconActive: "camera",
  },
  {
    name: "account",
    href: "/account",
    title: "Account Settings",
    label: "Account",
    icon: "settings-outline",
    iconActive: "settings",
  },
];
