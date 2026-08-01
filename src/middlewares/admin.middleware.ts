import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export interface AdminRequest extends Request { admin?: { id: string; email: string; role: string } }

export function requireAdmin(req: AdminRequest, res: Response, next: NextFunction) {
  const secret = process.env.JWT_SECRET;
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || !token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    if (payload.role !== "admin" || !payload.sub || !payload.email) return res.status(403).json({ error: "Forbidden" });
    req.admin = { id: String(payload.sub), email: String(payload.email), role: String(payload.role) };
    next();
  } catch { return res.status(401).json({ error: "Unauthorized" }); }
}
