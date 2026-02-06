import argon2 from "argon2";
import express from "express";
import { users } from "../db/schema";
import { db } from "../db/db";
import { Infer, z } from "zod";
import { signJwt } from "../account/jwt";
import { eq } from "drizzle-orm";
import { verificationEmailQueue } from "../queue/email";
import { logger } from "../lib/pino";

/** Validates signup request with email and password fields */
const SignupBodySchema = z.object({
  email: z
    .email({ error: "Invalid email" })
    .nonempty({ error: "Email can't be empty" }),
  password: z.string(),
});

/**
 * Generates a random 6-digit verification code.
 * Used for email verification during signup.
 */
export function generate6DigitCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

const router: express.Router = express.Router();

router.post("/signup", async (req, res) => {
  const body: Infer<typeof SignupBodySchema> = req.body;
  logger.info({ email: body.email }, "Signup attempt initiated");

  const parsed = SignupBodySchema.safeParse(body);
  if (!parsed.success) {
    logger.warn(
      { email: body.email, error: parsed.error },
      "Signup validation failed",
    );
    return res.send({
      success: false,
      reason: parsed.error,
      token: "",
    });
  }

  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email));

  if (existingUsers.length > 0) {
    logger.warn({ email: body.email }, "Signup failed: email already in use");
    return res.send({
      success: false,
      reason: "Email already used!",
    });
  }

  const hashedPassword = await argon2.hash(body.password);
  const code = generate6DigitCode();

  const user = await db
    .insert(users)
    .values({
      email: body.email,
      password: hashedPassword,
      emailCode: code,
    })
    .returning();

  await verificationEmailQueue.add("sendVerificationEmail", {
    email: body.email,
    code,
  });

  logger.info(
    { userId: user[0]!.id, email: body.email },
    "Verification email queued",
  );

  const jwt = await signJwt(
    { id: user[0]!.id, type: "parent" },
    "urn:buddy:users",
  );

  logger.info(
    { userId: user[0]!.id, email: body.email },
    "User signup completed successfully",
  );

  res.send({
    success: true,
    token: jwt,
    reason: "",
  });
});

export default router;
