import { beforeEach, describe, expect, test, vi } from "vitest";
import argon2 from "argon2";
import * as jose from "jose";
import { db } from "../src/db/db";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";
import signinRouter from "../src/routes/signin";
import type { Request, Response } from "express";
import { verifyGoogleIdToken } from "../src/account/google";
import { signJwt } from "../src/account/jwt";

const sendMail = vi.fn();

vi.mock("../src/email/email", () => ({
  getTransporter: () => ({
    sendMail,
  }),
}));

vi.mock("../src/account/google", () => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../src/account/jwt", async () => {
  const actual = await vi.importActual<typeof import("../src/account/jwt")>(
    "../src/account/jwt",
  );

  return {
    ...actual,
    signJwt: vi.fn(),
  };
});

describe("Signin Routes", () => {
  beforeEach(() => {
    process.env.RESET_PASSWORD_JWT_SECRET = "test-reset-secret";
    process.env.SMTP_EMAIL = "buddy@example.com";
    process.env.BASE_URL = "https://buddy.example";
    sendMail.mockReset();
    vi.mocked(verifyGoogleIdToken).mockReset();
    vi.mocked(signJwt).mockReset();
    vi.mocked(signJwt).mockResolvedValue("signed-jwt");
  });

  function getRouteHandler(path: string, method: "get" | "post") {
    const layer = (
      signinRouter as unknown as {
        stack: Array<{
          route?: {
            path: string;
            methods: Record<string, boolean>;
            stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
          };
        }>;
      }
    ).stack.find(
      (candidate) =>
        candidate.route?.path === path && candidate.route.methods[method],
    );

    if (!layer?.route?.stack[0]) {
      throw new Error(`Route handler for ${path} not found`);
    }

    return layer.route.stack[0].handle;
  }

  async function invokeRoute(
    path: string,
    method: "get" | "post",
    options?: { body?: unknown; params?: Record<string, string> },
  ) {
    const handler = getRouteHandler(path, method);
    const req = {
      body: options?.body,
      params: options?.params ?? {},
    } as Request;
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      responseType: undefined as string | undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type(value: string) {
        this.responseType = value;
        return this;
      },
      send(payload: unknown) {
        this.body = payload;
        return this;
      },
    } as Response & {
      statusCode: number;
      body: unknown;
      responseType?: string;
    };

    await handler(req, res);

    return res;
  }

  test("should send a password reset email with a signed reset link", async () => {
    const response = await invokeRoute("/resetpassword", "post", {
      body: {
        email: "test@example.com",
      },
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
    expect(sentLink.startsWith("https://buddy.example/reset-password/")).toBe(
      true,
    );
    const token = sentLink.split("/").pop();

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

    const response = await invokeRoute("/reset-password/:token", "post", {
      params: { token },
      body: {
        password: "new-password",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.responseType).toBe("html");
    expect(String(response.body)).toContain(
      "Your password has been updated successfully.",
    );

    const updatedUser = (
      await db.select().from(users).where(eq(users.id, 1)).limit(1)
    )[0];

    expect(updatedUser).toBeTruthy();
    expect(await argon2.verify(updatedUser!.password, "new-password")).toBe(
      true,
    );
  });

  test("should create a new verified user from a valid Google login", async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({
      email: "google-user@example.com",
      emailVerified: true,
      subject: "google-subject-1",
    });

    const response = await invokeRoute("/signin/google", "post", {
      body: {
        idToken: "google-id-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      token: "signed-jwt",
      reason: "",
    });

    const insertedUser = (
      await db
        .select()
        .from(users)
        .where(eq(users.email, "google-user@example.com"))
        .limit(1)
    )[0];

    expect(insertedUser).toBeTruthy();
    expect(insertedUser!.emailVerified).toBe(true);
    expect(insertedUser!.emailCode).toHaveLength(6);
    expect(await argon2.verify(insertedUser!.password, "google-id-token")).toBe(
      false,
    );
    expect(signJwt).toHaveBeenCalledWith(
      { id: insertedUser!.id, type: "parent" },
      "urn:buddy:users",
    );
  });

  test("should log in an existing user with Google and mark it verified", async () => {
    await db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.email, "test@example.com"));

    vi.mocked(verifyGoogleIdToken).mockResolvedValue({
      email: "test@example.com",
      emailVerified: true,
      subject: "google-subject-2",
    });

    const response = await invokeRoute("/signin/google", "post", {
      body: {
        idToken: "google-id-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      token: "signed-jwt",
      reason: "",
    });

    const updatedUser = (
      await db.select().from(users).where(eq(users.email, "test@example.com"))
    )[0];

    expect(updatedUser).toBeTruthy();
    expect(updatedUser!.emailVerified).toBe(true);
    expect(signJwt).toHaveBeenCalledWith(
      { id: updatedUser!.id, type: "parent" },
      "urn:buddy:users",
    );
  });

  test("should render the hosted reset password form for a valid token", async () => {
    const token = await new jose.SignJWT({ id: 1, type: "password_reset" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("urn:lajosh:buddy")
      .setAudience("urn:buddy:password-reset")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.RESET_PASSWORD_JWT_SECRET!));

    const response = await invokeRoute("/reset-password/:token", "get", {
      params: { token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.responseType).toBe("html");
    expect(String(response.body)).toContain("Reset Password");
    expect(String(response.body)).toContain(
      `action="/reset-password/${encodeURIComponent(token)}"`,
    );
  });
});
