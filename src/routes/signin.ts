import argon2 from "argon2";
import express from "express";
import { users, linkedDevices } from "../db/schema";
import { db } from "../db/db";
import { Infer, z } from "zod";
import { signJwt } from "../account/jwt";
import { eq } from "drizzle-orm";
import { logger } from "../lib/pino";
import * as jose from "jose";
import { getTransporter } from "../email/email";

/** Validates signin request body with email and password */
const SigninBodySchema = z.object({
  email: z
    .string()
    .transform((val) => val.trim())
    .pipe(
      z
        .email({ error: "Invalid email" })
        .nonempty({ error: "Email can't be empty" }),
    ),
  password: z.string(),
});

const ResetPasswordRequestSchema = z.object({
  email: z
    .string()
    .transform((val) => val.trim())
    .pipe(
      z
        .email({ error: "Invalid email" })
        .nonempty({ error: "Email can't be empty" }),
    ),
  link: z.url({ error: "Invalid link" }),
});

const ResetPasswordConfirmSchema = z.object({
  token: z.string().min(1, { error: "Token can't be empty" }),
  password: z.string().min(1, { error: "Password can't be empty" }),
});

const router: express.Router = express.Router();

function getResetPasswordSecret(): Uint8Array {
  const secret = process.env.RESET_PASSWORD_JWT_SECRET;

  if (!secret) {
    logger.error("RESET_PASSWORD_JWT_SECRET environment variable not set");
    throw new Error("RESET_PASSWORD_JWT_SECRET not configured");
  }

  return new TextEncoder().encode(secret);
}

async function signResetPasswordToken(userId: number): Promise<string> {
  return new jose.SignJWT({ id: userId, type: "password_reset" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("urn:lajosh:buddy")
    .setAudience("urn:buddy:password-reset")
    .setExpirationTime("1h")
    .sign(getResetPasswordSecret());
}

async function verifyResetPasswordToken(token: string): Promise<number> {
  const { payload } = await jose.jwtVerify(token, getResetPasswordSecret(), {
    issuer: "urn:lajosh:buddy",
    audience: "urn:buddy:password-reset",
  });

  if (payload.type !== "password_reset" || typeof payload.id !== "number") {
    throw new Error("Invalid reset token payload");
  }

  return payload.id;
}

router.post("/resetpassword", async (req, res) => {
  const requestResetParsed = ResetPasswordRequestSchema.safeParse(req.body);

  if (requestResetParsed.success) {
    const { email, link } = requestResetParsed.data;
    logger.info({ email }, "Password reset requested");

    const existingUser = (
      await db.select().from(users).where(eq(users.email, email)).limit(1)
    )[0];

    if (!existingUser) {
      logger.info({ email }, "Password reset requested for unknown email");
      return res.send({
        success: true,
        reason: "",
      });
    }

    try {
      const token = await signResetPasswordToken(existingUser.id);
      const separator = link.includes("?") ? "&" : "?";
      const resetLink = `${link}${separator}token=${encodeURIComponent(token)}`;

      await getTransporter().sendMail({
        from: `"Buddy 🐶" <${process.env.SMTP_EMAIL}>`,
        to: email,
        subject: "Buddy password reset",
        text: `Your Buddy password reset link is ${resetLink}`,
      });

      logger.info(
        { email, userId: existingUser.id },
        "Password reset email sent",
      );

      return res.send({
        success: true,
        reason: "",
      });
    } catch (error) {
      logger.error({ error, email }, "Failed to send password reset email");
      return res.status(500).send({
        success: false,
        reason: "Failed to send password reset email",
      });
    }
  }

  const confirmResetParsed = ResetPasswordConfirmSchema.safeParse(req.body);

  if (!confirmResetParsed.success) {
    logger.warn(
      { error: confirmResetParsed.error },
      "Reset password validation failed",
    );
    return res.status(400).send({
      success: false,
      reason: confirmResetParsed.error,
    });
  }

  try {
    const userId = await verifyResetPasswordToken(confirmResetParsed.data.token);
    const hashedPassword = await argon2.hash(confirmResetParsed.data.password);

    const updatedUsers = await db
      .update(users)
      .set({ password: hashedPassword })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (updatedUsers.length === 0) {
      logger.warn({ userId }, "Password reset failed: user not found");
      return res.status(400).send({
        success: false,
        reason: "Invalid or expired reset token",
      });
    }

    logger.info({ userId }, "Password reset completed successfully");
    return res.send({
      success: true,
      reason: "",
    });
  } catch (error) {
    logger.warn({ error }, "Password reset failed: invalid token");
    return res.status(400).send({
      success: false,
      reason: "Invalid or expired reset token",
    });
  }
});

router.post("/signin", async (req, res) => {
  const body: Infer<typeof SigninBodySchema> = req.body;
  logger.info({ email: body.email }, "Signin attempt initiated");

  const parsed = SigninBodySchema.safeParse(body);

  if (!parsed.success) {
    logger.warn(
      { email: body.email, error: parsed.error },
      "Signin validation failed",
    );
    res.send({
      success: false,
      reason: parsed.error,
      token: "",
    });
    return;
  }

  const existingUser = (
    await db.select().from(users).where(eq(users.email, body.email)).limit(1)
  )[0];

  if (!existingUser) {
    logger.warn({ email: body.email }, "Signin failed: user not found");
    res.send({
      success: false,
      reason: "Invalid email or password",
    });
    return;
  }

  const validPassword = await argon2.verify(
    existingUser.password,
    body.password,
  );

  if (!validPassword) {
    logger.warn(
      { email: body.email, userId: existingUser.id },
      "Signin failed: invalid password",
    );
    res.send({
      success: false,
      reason: "Invalid email or password",
    });
    return;
  }

  const jwt = await signJwt(
    { id: existingUser.id, type: "parent" },
    "urn:buddy:users",
  );

  logger.info(
    { userId: existingUser.id, email: body.email },
    "User signin successful",
  );

  res.send({
    success: true,
    token: jwt,
    reason: "",
  });
});

router.post("/kid/link", async (req, res) => {
  const body: Infer<typeof SigninBodySchema> = req.body;

  const parsed = SigninBodySchema.safeParse(body);

  if (!parsed.success) {
    logger.warn({ error: parsed.error }, "Kid link validation failed");
    res.send({
      success: false,
      reason: parsed.error,
      token: "",
    });
    return;
  }

  logger.info({ email: parsed.data.email }, "Kid link request initiated");

  const existingUser = (
    await db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1)
  )[0];

  if (!existingUser) {
    logger.warn(
      { email: parsed.data.email },
      "Kid link failed: user not found",
    );
    res.send({
      success: false,
      reason: "Invalid email or password",
    });
    return;
  }

  logger.debug({ email: parsed.data.email }, "User found for kid link");

  const validPassword = await argon2.verify(
    existingUser.password,
    parsed.data.password,
  );

  if (!validPassword) {
    res.send({
      success: false,
      reason: "Invalid email or password",
    });
    return;
  }

  if (!existingUser.emailVerified) {
    res.send({
      success: false,
      reason: "You must verify your email in the parent app before using Buddy",
    });
    return;
  }

  const newDevice = (
    await db
      .insert(linkedDevices)
      .values({ parentId: existingUser.id })
      .returning({ id: linkedDevices.id })
  )[0];

  const jwt = await signJwt(
    { id: newDevice!.id, type: "child" },
    "urn:buddy:devices",
  );

  logger.info(
    { deviceId: newDevice!.id, parentId: existingUser.id },
    "New child device linked successfully",
  );

  res.send({
    success: true,
    token: jwt,
    reason: "",
  });
});

export default router;
