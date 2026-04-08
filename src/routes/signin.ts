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
import { verifyGoogleIdToken } from "../account/google";
import { randomUUID } from "node:crypto";
import { redis } from "../db/redis/client";
import {
  getKidLinkCodeRedisKey,
  KID_LINK_CODE_REGEX,
  normalizeKidLinkCode,
} from "../account/kid_link_code";

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
});

const ResetPasswordConfirmSchema = z.object({
  token: z.string().min(1, { error: "Token can't be empty" }),
  password: z.string().min(1, { error: "Password can't be empty" }),
});

const GoogleSigninBodySchema = z.object({
  idToken: z.string().min(1, { error: "Google ID token can't be empty" }),
});

const KidLinkBodySchema = z.object({
  code: z
    .string()
    .transform((value) => normalizeKidLinkCode(value))
    .refine((value) => KID_LINK_CODE_REGEX.test(value), {
      message: "Code must match AAA-AAA format",
    }),
});

const router: express.Router = express.Router();
router.use(express.urlencoded({ extended: true }));

function generate6DigitCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

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

function getResetPasswordBaseUrl(): string {
  const baseUrl = process.env.BASE_URL;

  if (!baseUrl) {
    logger.error("BASE_URL environment variable not set");
    throw new Error("BASE_URL not configured");
  }

  return baseUrl.replace(/\/+$/, "");
}

function renderResetPasswordPage(
  token: string,
  options?: { error?: string; success?: string },
): string {
  const title = options?.success ? "Password Updated" : "Reset Password";
  const message = options?.success
    ? "Your Buddy password was updated. You can return to the app and sign in with your new password."
    : "Enter a new password for your Buddy account.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Arial, Helvetica, sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: linear-gradient(180deg, #fff5f5 0%, #ffe3e3 100%);
      color: #1f2937;
    }
    main {
      width: min(92vw, 420px);
      background: #ffffff;
      border-radius: 18px;
      padding: 32px 24px;
      box-shadow: 0 18px 40px rgba(244, 46, 46, 0.16);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
    }
    p {
      margin: 0 0 20px;
      line-height: 1.5;
    }
    form {
      display: grid;
      gap: 12px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d1d5db;
      border-radius: 12px;
      padding: 14px 16px;
      font-size: 16px;
    }
    button {
      border: 0;
      border-radius: 12px;
      padding: 14px 16px;
      font-size: 16px;
      font-weight: 700;
      background: #f42e2e;
      color: white;
      cursor: pointer;
    }
    .error {
      margin-bottom: 16px;
      color: #b91c1c;
      background: #fee2e2;
      padding: 12px 14px;
      border-radius: 12px;
    }
    .success {
      margin-bottom: 16px;
      color: #166534;
      background: #dcfce7;
      padding: 12px 14px;
      border-radius: 12px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    ${options?.error ? `<div class="error">${options.error}</div>` : ""}
    ${options?.success ? `<div class="success">${options.success}</div>` : ""}
    ${
      options?.success
        ? ""
        : `<form method="post" action="/reset-password/${encodeURIComponent(token)}">
      <input type="password" name="password" placeholder="New password" required />
      <button type="submit">Update password</button>
    </form>`
    }
  </main>
</body>
</html>`;
}

router.post("/resetpassword", async (req, res) => {
  const requestResetParsed = ResetPasswordRequestSchema.safeParse(req.body);

  if (requestResetParsed.success) {
    const { email } = requestResetParsed.data;
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
      const resetLink = `${getResetPasswordBaseUrl()}/reset-password/${encodeURIComponent(token)}`;

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
    const userId = await verifyResetPasswordToken(
      confirmResetParsed.data.token,
    );
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

router.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;

  try {
    await verifyResetPasswordToken(token);
    return res.status(200).type("html").send(renderResetPasswordPage(token));
  } catch (error) {
    logger.warn({ error }, "Reset password page opened with invalid token");
    return res
      .status(400)
      .type("html")
      .send(
        renderResetPasswordPage(token, {
          error: "This reset link is invalid or has expired.",
        }),
      );
  }
});

router.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const parsed = z
    .object({
      password: z.string().min(1, { error: "Password can't be empty" }),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res
      .status(400)
      .type("html")
      .send(
        renderResetPasswordPage(token, {
          error: "Please enter a new password.",
        }),
      );
  }

  try {
    const userId = await verifyResetPasswordToken(token);
    const hashedPassword = await argon2.hash(parsed.data.password);

    const updatedUsers = await db
      .update(users)
      .set({ password: hashedPassword })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (updatedUsers.length === 0) {
      return res
        .status(400)
        .type("html")
        .send(
          renderResetPasswordPage(token, {
            error: "This reset link is invalid or has expired.",
          }),
        );
    }

    logger.info({ userId }, "Password reset completed from hosted form");
    return res
      .status(200)
      .type("html")
      .send(
        renderResetPasswordPage(token, {
          success: "Your password has been updated successfully.",
        }),
      );
  } catch (error) {
    logger.warn({ error }, "Hosted password reset failed");
    return res
      .status(400)
      .type("html")
      .send(
        renderResetPasswordPage(token, {
          error: "This reset link is invalid or has expired.",
        }),
      );
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

router.post("/signin/google", async (req, res) => {
  const parsed = GoogleSigninBodySchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn({ error: parsed.error }, "Google signin validation failed");
    return res.send({
      success: false,
      reason: parsed.error,
      token: "",
    });
  }

  try {
    const googleProfile = await verifyGoogleIdToken(parsed.data.idToken);

    if (!googleProfile.emailVerified) {
      logger.warn(
        { email: googleProfile.email, subject: googleProfile.subject },
        "Google signin rejected: email not verified by Google",
      );
      return res.send({
        success: false,
        reason: "Google account email is not verified",
        token: "",
      });
    }

    let existingUser = (
      await db
        .select()
        .from(users)
        .where(eq(users.email, googleProfile.email))
        .limit(1)
    )[0];

    if (!existingUser) {
      const placeholderPassword = await argon2.hash(randomUUID());
      const insertedUsers = await db
        .insert(users)
        .values({
          email: googleProfile.email,
          password: placeholderPassword,
          emailVerified: true,
          emailCode: generate6DigitCode(),
        })
        .returning();

      existingUser = insertedUsers[0];

      logger.info(
        { userId: existingUser!.id, email: googleProfile.email },
        "Created new user from Google signin",
      );
    } else if (!existingUser.emailVerified) {
      const updatedUsers = await db
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, existingUser.id))
        .returning();

      existingUser = updatedUsers[0];

      logger.info(
        { userId: existingUser!.id, email: googleProfile.email },
        "Marked existing user as verified from Google signin",
      );
    }

    const jwt = await signJwt(
      { id: existingUser!.id, type: "parent" },
      "urn:buddy:users",
    );

    logger.info(
      { userId: existingUser!.id, email: googleProfile.email },
      "Google signin successful",
    );

    return res.send({
      success: true,
      token: jwt,
      reason: "",
    });
  } catch (error) {
    logger.warn({ error }, "Google signin failed");
    return res.send({
      success: false,
      reason: "Invalid Google token",
      token: "",
    });
  }
});

router.post("/kid/link", async (req, res) => {
  const parsed = KidLinkBodySchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn({ error: parsed.error }, "Kid link validation failed");
    res.send({
      success: false,
      reason: parsed.error.issues[0]?.message || "Invalid code format",
      token: "",
    });
    return;
  }

  logger.info("Kid link request initiated with one-time code");

  const redisKey = getKidLinkCodeRedisKey(parsed.data.code);
  let parentIdRaw: string | null = null;

  try {
    parentIdRaw = await redis.getdel(redisKey);
  } catch (error) {
    logger.error({ error }, "Failed to consume kid link code from Redis");
    res.send({
      success: false,
      reason: "Failed to link device",
    });
    return;
  }

  if (!parentIdRaw) {
    logger.warn("Kid link failed: code missing or expired");
    res.send({
      success: false,
      reason: "Invalid or expired code",
    });
    return;
  }

  const parentId = Number(parentIdRaw);
  if (!Number.isInteger(parentId) || parentId <= 0) {
    logger.error({ parentIdRaw }, "Kid link code resolved to invalid parent ID");
    res.send({
      success: false,
      reason: "Invalid or expired code",
    });
    return;
  }

  const existingUser = (
    await db.select().from(users).where(eq(users.id, parentId)).limit(1)
  )[0];

  if (!existingUser) {
    logger.warn({ parentId }, "Kid link failed: parent not found");
    res.send({
      success: false,
      reason: "Invalid or expired code",
    });
    return;
  }

  if (!existingUser.emailVerified) {
    logger.warn(
      { parentId },
      "Kid link failed: parent email not verified",
    );
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
    { deviceId: newDevice!.id, parentId },
    "New child device linked successfully",
  );

  res.send({
    success: true,
    token: jwt,
    reason: "",
  });
});

export default router;
