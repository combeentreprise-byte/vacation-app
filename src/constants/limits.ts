// Each of these mirrors a `*_length` check constraint in supabase/schema.sql —
// change both together.
export const GROUP_NAME_MAX_LENGTH = 50;
export const GROUP_DESCRIPTION_MAX_LENGTH = 300;
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
export const GROUP_DESCRIPTION_MAX_LINES = 8;

// Mirrors the cap enforced inside set_group_pinned in supabase/schema.sql.
export const MAX_PINNED_GROUPS = 3;
