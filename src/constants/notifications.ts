// The switches in Account → Notifications. Every notification the app sends
// belongs to exactly one of these (the full list, with wording, is in
// docs/notifications.md) — add a kind there and give it a category here
// rather than adding a switch per notification.

export type NotificationCategory =
  | "myExpenses"
  | "settlements"
  | "otherExpenses"
  | "members"
  | "groupChanges"
  | "aboutMe"
  | "plans"
  | "reminders";

export type NotificationSection = {
  title: string;
  // Plan sections are hidden while plans are (plansVisible in AccessProvider).
  plansOnly?: boolean;
  categories: {
    key: NotificationCategory;
    label: string;
    hint: string;
    defaultOn: boolean;
  }[];
};

export const NOTIFICATION_SECTIONS: NotificationSection[] = [
  {
    title: "Entries",
    categories: [
      {
        key: "myExpenses",
        label: "Entries with you",
        hint: "Added, edited or deleted entries you're part of",
        defaultOn: true,
      },
      {
        key: "settlements",
        label: "Settling up",
        hint: "When someone pays you back or marks your debt as paid",
        defaultOn: true,
      },
      {
        key: "otherExpenses",
        label: "All other entries",
        hint: "Entries in your groups that don't include you",
        defaultOn: false,
      },
    ],
  },
  {
    title: "Groups",
    categories: [
      {
        key: "aboutMe",
        label: "About you",
        hint: "Being made admin or sponsor, losing admin, or being removed",
        defaultOn: true,
      },
      {
        key: "members",
        label: "Members",
        hint: "Someone joining, leaving or being removed",
        defaultOn: true,
      },
      {
        key: "groupChanges",
        label: "Group changes",
        hint: "Name, description, photo, currency and other members' roles",
        defaultOn: true,
      },
    ],
  },
  {
    title: "Plans",
    plansOnly: true,
    categories: [
      {
        key: "plans",
        label: "Passes and seats",
        hint: "A pass set up for your group, or a seat given to or taken from you",
        defaultOn: true,
      },
      {
        key: "reminders",
        label: "Reminders",
        hint: "Before your pass or subscription ends or renews, and when free entries run low",
        defaultOn: true,
      },
    ],
  },
];

export const DEFAULT_NOTIFICATION_CATEGORIES = Object.fromEntries(
  NOTIFICATION_SECTIONS.flatMap((section) =>
    section.categories.map((category) => [category.key, category.defaultOn])
  )
) as Record<NotificationCategory, boolean>;
