import { randomInt } from "node:crypto";

const KID_LINK_CODE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const KID_LINK_CODE_TTL_SECONDS = 5 * 60;
export const KID_LINK_CODE_REGEX = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

export function generateKidLinkCode(): string {
  const rawCode = Array.from({ length: 6 }, () => {
    const index = randomInt(0, KID_LINK_CODE_CHARACTERS.length);
    return KID_LINK_CODE_CHARACTERS[index]!;
  }).join("");

  return `${rawCode.slice(0, 3)}-${rawCode.slice(3)}`;
}

export function normalizeKidLinkCode(value: string): string {
  return value.trim().toUpperCase();
}

export function getKidLinkCodeRedisKey(code: string): string {
  return `kid-link-code:${code}`;
}
