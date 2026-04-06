import * as jose from "jose";
import { logger } from "../lib/pino";

const googleJwks = jose.createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export interface GoogleUserProfile {
  email: string;
  emailVerified: boolean;
  subject: string;
}

export async function verifyGoogleIdToken(
  token: string,
): Promise<GoogleUserProfile> {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;

  if (!googleClientId) {
    logger.error("GOOGLE_CLIENT_ID environment variable not set");
    throw new Error("GOOGLE_CLIENT_ID not configured");
  }

  const { payload } = await jose.jwtVerify(token, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: googleClientId,
  });

  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("Google token is missing email");
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Google token is missing subject");
  }

  return {
    email: payload.email,
    emailVerified: payload.email_verified === true,
    subject: payload.sub,
  };
}
