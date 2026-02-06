import { Request, Response, NextFunction } from "express";
import * as jose from "jose";
import { verifyJwt } from "../account/jwt";
import { logger } from "../lib/pino";

/**
 * Extends Express Request interface to include authenticated user information.
 * Used by both parent and device authentication middleware.
 */
declare module "express" {
  interface Request {
    user?: {
      id: number;
      type: "parent" | "child";
    };
  }
}

interface ParentJwtPayload extends jose.JWTPayload {
  type: "parent";
  id: number;
}

interface ChildJwtPayload extends jose.JWTPayload {
  type: "child";
  id: number;
}

/**
 * Middleware to authenticate parent users.
 * Verifies JWT tokens and ensures they're for parent accounts.
 */
export async function authParent(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn(
      { path: req.path },
      "Parent auth: Missing or invalid authorization header",
    );
    res.status(401).json({
      success: false,
      reason: "Missing or invalid authorization header",
    });
    return;
  }

  const token = authHeader.substring(7);

  if (!token) {
    logger.warn({ path: req.path }, "Parent auth: Empty token");
    res.status(401).json({
      success: false,
      reason: "Missing authorization token",
    });
    return;
  }

  try {
    const payload = (await verifyJwt(
      token,
      "urn:buddy:users",
    )) as ParentJwtPayload;

    if (payload.type !== "parent") {
      logger.warn(
        { path: req.path, tokenType: payload.type },
        "Parent auth: Invalid token type",
      );
      res.status(401).json({
        success: false,
        reason: "Invalid token type",
      });
      return;
    }

    const userId = payload.id;
    if (!userId || typeof userId !== "number") {
      logger.error(
        { path: req.path, userId },
        "Parent auth: Invalid user ID in token",
      );
      res.status(401).json({
        success: false,
        reason: "Invalid token payload",
      });
      return;
    }

    req.user = {
      id: userId,
      type: "parent",
    };

    logger.debug(
      { path: req.path, userId },
      "Parent authenticated successfully",
    );
    next();
  } catch (e) {
    logger.warn(
      { error: e, path: req.path },
      "Parent auth: Token verification failed",
    );
    res.status(401).json({
      success: false,
      reason: "Invalid or expired token",
    });
  }
}

/**
 * Middleware to authenticate child devices.
 * Verifies JWT tokens and ensures they're for device accounts.
 */
export async function authDevice(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn(
      { path: req.path },
      "Device auth: Missing or invalid authorization header",
    );
    res.status(401).json({
      success: false,
      reason: "Missing or invalid authorization header",
    });
    return;
  }

  const token = authHeader.substring(7);

  if (!token) {
    logger.warn({ path: req.path }, "Device auth: Empty token");
    res.status(401).json({
      success: false,
      reason: "Missing authorization token",
    });
    return;
  }

  try {
    const payload = (await verifyJwt(
      token,
      "urn:buddy:devices",
    )) as ChildJwtPayload;

    if (payload.type !== "child") {
      logger.warn(
        { path: req.path, tokenType: payload.type },
        "Device auth: Invalid token type",
      );
      res.status(401).json({
        success: false,
        reason: "Invalid token type",
      });
      return;
    }

    const deviceId = payload.id;
    if (!deviceId || typeof deviceId !== "number") {
      logger.error(
        { path: req.path, deviceId },
        "Device auth: Invalid device ID in token",
      );
      res.status(401).json({
        success: false,
        reason: "Invalid token payload",
      });
      return;
    }

    req.user = {
      id: deviceId,
      type: "child",
    };

    logger.debug(
      { path: req.path, deviceId },
      "Device authenticated successfully",
    );
    next();
  } catch (e) {
    logger.warn(
      { error: e, path: req.path },
      "Device auth: Token verification failed",
    );
    res.status(401).json({
      success: false,
      reason: "Invalid or expired token",
    });
  }
}
