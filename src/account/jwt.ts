import * as jose from "jose";
import { logger } from "../lib/pino";

const privateKey = process.env.JWT_PRIVATE_KEY;
const publicKey = process.env.JWT_PUBLIC_KEY;

/**
 * Creates a signed JWT token with the provided payload.
 * Tokens are set to expire in 1000 years (effectively never).
 */
export async function signJwt(
  payload: Record<string, unknown>,
  audience: string,
) {
  try {
    if (!privateKey) {
      logger.error("JWT_PRIVATE_KEY environment variable not set");
      throw new Error("JWT private key not configured");
    }

    if (!payload || typeof payload !== "object") {
      logger.error({ payload }, "Invalid payload for JWT signing");
      throw new Error("Invalid JWT payload");
    }

    if (!audience || typeof audience !== "string") {
      logger.error({ audience }, "Invalid audience for JWT signing");
      throw new Error("Invalid JWT audience");
    }

    const privateKeyJose = await jose.importPKCS8(privateKey, "RS256");

    const jwt = await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setIssuer("urn:lajosh:buddy")
      .setAudience(audience)
      .setExpirationTime("1000years")
      .sign(privateKeyJose);

    logger.debug(
      { audience, payloadType: payload.type },
      "JWT signed successfully",
    );
    return jwt;
  } catch (e) {
    logger.error(
      { error: e, audience, payloadType: payload?.type },
      "Failed to sign JWT",
    );
    throw e;
  }
}

/**
 * Verifies a JWT token and returns the payload if valid.
 * Checks signature, issuer, and audience claims.
 */
export async function verifyJwt(token: string, audience: string) {
  try {
    if (!publicKey) {
      logger.error("JWT_PUBLIC_KEY environment variable not set");
      throw new Error("JWT public key not configured");
    }

    if (!token || typeof token !== "string") {
      logger.warn("Invalid token for JWT verification");
      throw new Error("Invalid token");
    }

    if (!audience || typeof audience !== "string") {
      logger.error({ audience }, "Invalid audience for JWT verification");
      throw new Error("Invalid JWT audience");
    }

    const publicKeyJose = await jose.importSPKI(publicKey, "RS256");
    const { payload } = await jose.jwtVerify(token, publicKeyJose, {
      issuer: "urn:lajosh:buddy",
      audience: audience,
    });

    logger.debug(
      { audience, payloadType: payload.type as string },
      "JWT verified successfully",
    );
    return payload;
  } catch (e) {
    logger.warn({ error: e, audience }, "JWT verification failed");
    throw e;
  }
}
