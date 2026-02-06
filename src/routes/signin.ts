import argon2 from "argon2";
import express from "express";
import { users, linkedDevices } from "../db/schema";
import { db } from "../db/db";
import { Infer, z } from "zod";
import { signJwt } from "../account/jwt";
import { eq } from "drizzle-orm";
import { logger } from "../lib/pino";

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

const router: express.Router = express.Router();

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
