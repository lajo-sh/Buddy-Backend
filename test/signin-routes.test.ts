import { beforeEach, describe, expect, test, vi } from "vitest";
import argon2 from "argon2";
import * as jose from "jose";
import { db } from "../src/db/db";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";
import signinRouter from "../src/routes/signin";
import type { Request, Response } from "express";

const sendMail = vi.fn();

vi.mock("../src/email/email", () => ({
  getTransporter: () => ({
    sendMail,
  }),
}));

describe("Signin Routes", () => {
  beforeEach(() => {
    process.env.RESET_PASSWORD_JWT_SECRET = "test-reset-secret";
    process.env.SMTP_EMAIL = "buddy@example.com";
    sendMail.mockReset();
  });

  function getRouteHandler(path: string) {
    const layer = (
      signinRouter as unknown as {
        stack: Array<{
          route?: {
            path: string;
            stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
          };
        }>;
      }
    ).stack.find((candidate) => candidate.route?.path === path);

    if (!layer?.route?.stack[0]) {
      throw new Error(`Route handler for ${path} not found`);
    }

    return layer.route.stack[0].handle;
  }

  async function invokeRoute(body: unknown) {
    const handler = getRouteHandler("/resetpassword");
    const req = { body } as Request;
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(payload: unknown) {
        this.body = payload;
        return this;
      },
    } as Response & { statusCode: number; body: unknown };

    await handler(req, res);

    return res;
  }

  test("should send a password reset email with a signed reset link", async () => {
    const response = await invokeRoute({
      email: "test@example.com",
      link: "https://buddy.example/reset-password",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      reason: "",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const mail = sendMail.mock.calls[0]?.[0];
    expect(mail.subject).toBe("Buddy password reset");
    expect(mail.text).toContain("Your Buddy password reset link is ");

    const sentLink = mail.text.replace(
      "Your Buddy password reset link is ",
      "",
    );
    const token = new URL(sentLink).searchParams.get("token");

    expect(token).toBeTruthy();

    const { payload } = await jose.jwtVerify(
      token!,
      new TextEncoder().encode(process.env.RESET_PASSWORD_JWT_SECRET),
      {
        issuer: "urn:lajosh:buddy",
        audience: "urn:buddy:password-reset",
      },
    );

    expect(payload.id).toBe(1);
    expect(payload.type).toBe("password_reset");
  });

  test("should update the user password when given a valid reset token", async () => {
    const token = await new jose.SignJWT({ id: 1, type: "password_reset" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("urn:lajosh:buddy")
      .setAudience("urn:buddy:password-reset")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.RESET_PASSWORD_JWT_SECRET!));

    const response = await invokeRoute({
      token,
      password: "new-password",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      reason: "",
    });

    const updatedUser = (
      await db.select().from(users).where(eq(users.id, 1)).limit(1)
    )[0];

    expect(updatedUser).toBeTruthy();
    expect(await argon2.verify(updatedUser!.password, "new-password")).toBe(
      true,
    );
  });
});
