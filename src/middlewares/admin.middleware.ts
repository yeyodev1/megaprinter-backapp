import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { UserModel, UserRole } from "../models/user.model";

export interface AdminRequest extends Request { admin?: { id: string; email: string; role: string; name: string } }

/** Nombre visible de quien hizo algo (historial de tickets, pedidos): nombre o correo. */
export const actorName = (req: AdminRequest) => req.admin?.name || req.admin?.email || "";

/**
 * Valida el JWT y que el rol este en la lista. Al tecnico ademas se le revisa en
 * la base que siga activo: desactivarlo desde "Técnicos" corta su sesion al
 * instante, sin esperar los 30 dias del token.
 */
export const requireRole = (...roles: UserRole[]) =>
  async function roleGuard(req: AdminRequest, res: Response, next: NextFunction) {
    const secret = process.env.JWT_SECRET;
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || !token) return res.status(401).json({ error: "Unauthorized" });

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, secret) as jwt.JwtPayload;
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const role = String(payload.role || "");
    if (!payload.sub || !roles.includes(role as UserRole)) return res.status(403).json({ error: "Forbidden" });

    if (role !== "admin") {
      try {
        const user = await UserModel.findById(payload.sub).select("active role").lean();
        if (!user || user.active === false || user.role !== role) return res.status(401).json({ error: "Tu acceso fue desactivado" });
      } catch (error) {
        return next(error);
      }
    }

    req.admin = { id: String(payload.sub), email: String(payload.email || ""), role, name: String(payload.name || "") };
    next();
  };

/** Solo administradores: pedidos, pagos, bot, catalogo, usuarios y configuracion. */
export const requireAdmin = requireRole("admin");

/** Administradores y tecnicos: tablero de tickets y perfil propio. */
export const requireStaff = requireRole("admin", "tecnico");
