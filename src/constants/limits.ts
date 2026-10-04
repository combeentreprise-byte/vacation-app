// Each of these mirrors a `*_length` check constraint in supabase/schema.sql —
// change both together.
export const GROUP_NAME_MAX_LENGTH = 50;
export const GROUP_DESCRIPTION_MAX_LENGTH = 150;
export const LOG_DETAILS_MAX_LENGTH = 100;
export const PROFILE_NAME_MAX_LENGTH = 25;

// Client-side only (no matching DB column constraint).
// Supabase Auth hashes passwords with bcrypt, which rejects anything over 72
// bytes, so allowing a longer one would just fail at submit time.
export const PASSWORD_MAX_LENGTH = 72;
// Mirrors Supabase Auth's configured minimum password length.
export const PASSWORD_MIN_LENGTH = 6;
// RFC 5321's maximum length for an email address.
export const EMAIL_MAX_LENGTH = 254;
// Explicit line breaks allowed in a text field (soft-wrapped lines don't count).
export const LOG_DETAILS_MAX_LINES = 5;
export const GROUP_DESCRIPTION_MAX_LINES = 4;

// Mirrors the cap enforced inside set_group_pinned in supabase/schema.sql.
export const MAX_PINNED_GROUPS = 3;

// Mirrors the cap enforced inside join_group in supabase/schema.sql: active
// members per group. Matches the biggest group plan (GROUP_PLAN_SIZES).
export const GROUP_MEMBER_LIMIT = 15;

// Mirrors billing_settings.free_entries_per_group's default in
// supabase/schema.sql: free entries every group shares. Only shown until the
// server has answered once — the server's own number is what applies.
export const FREE_ENTRIES_PER_GROUP = 15;
