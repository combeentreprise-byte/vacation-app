import { PASSWORD_MIN_LENGTH } from "@/constants/limits";

export type PasswordRequirement = {
  label: string;
  isMet: (password: string) => boolean;
};

// Mirrors the password rules configured in Supabase Auth (Authentication →
// Providers → Email) — add an entry here whenever a rule is added there, so
// the live checklist on the sign-up screen stays the full picture.
export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  {
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    isMet: (password) => password.length >= PASSWORD_MIN_LENGTH,
  },
];

export function meetsPasswordRequirements(password: string) {
  return PASSWORD_REQUIREMENTS.every((requirement) => requirement.isMet(password));
}
