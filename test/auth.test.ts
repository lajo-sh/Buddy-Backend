import { describe, test, expect, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import { authParent } from "../src/middleware/auth";
import { verifyJwt } from "../src/account/jwt";

vi.mock("../src/account/jwt", () => ({
  verifyJwt: vi.fn(),
}));

describe("Auth Middleware", () => {
  test("should authenticate valid parent token", async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      id: 1,
      type: "parent" as const,
    });

    const req = {
      headers: {
        authorization: "Bearer valid-token",
      },
    } as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    await authParent(req, res, next);

    expect(req.user).toEqual({
      id: 1,
      type: "parent",
    });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("should reject missing authorization header", async () => {
    const req = {
      headers: {},
      path: "/test",
    } as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    await authParent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      reason: "Missing or invalid authorization header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test("should reject invalid token format", async () => {
    const req = {
      headers: {
        authorization: "InvalidFormat token",
      },
      path: "/test",
    } as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    await authParent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      reason: "Missing or invalid authorization header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test("should reject invalid JWT", async () => {
    vi.mocked(verifyJwt).mockRejectedValueOnce(new Error("Invalid token"));

    const req = {
      headers: {
        authorization: "Bearer invalid-token",
      },
      path: "/test",
    } as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    await authParent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      reason: "Invalid or expired token",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
