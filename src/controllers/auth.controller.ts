import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { UserModel, migrateUserIndexes } from "../models/user.model";
import { AdminRequest } from "../middlewares/admin.middleware";
import { CustomError } from "../errors/customError.error";
import { isValidCedula, normalizeCedula, normalizeEmail, normalizePhone } from "../utils/identity";

const MIN_PASSWORD_LENGTH = 8;

const userDto = (user: {
  _id: { toString(): string };
  name: string;
  email?: string | null;
  phone?: string | null;
  cedula?: string | null;
  role?: string | null;
  active?: boolean | null;
  createdAt?: Date;
}) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email || "",
  phone: user.phone || "",
  cedula: user.cedula || "",
  role: user.role || "admin",
  active: user.active !== false,
  createdAt: user.createdAt,
});

// Usuarios creados antes de los tecnicos no tienen `role`: son admins.
const ADMIN_FILTER = { role: { $in: ["admin", null] } };

export async function ensureInitialAdmin() {
  await migrateUserIndexes();

  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  const name = process.env.INITIAL_ADMIN_NAME || "Administrador";

  if (!email || !password) {
    // Antes esto lanzaba y tumbaba el arranque entero. Si ya existe un admin en
    // la base, no hay ninguna razon para impedir que el servidor levante.
    console.warn(
      "INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD no definidos: se omite la creación del admin inicial.",
    );
    return;
  }

  // El email se normaliza aqui igual que en la comprobacion. Antes se buscaba
  // en minusculas pero se creaba con el valor crudo del .env, asi que un email
  // con mayusculas creaba un admin nuevo en cada arranque y el login (que
  // tambien normaliza) nunca lo encontraba.
  const normalisedEmail = email.trim().toLowerCase();

  if (await UserModel.exists({ email: normalisedEmail })) return;

  await UserModel.create({
    name,
    email: normalisedEmail,
    passwordHash: await bcrypt.hash(password, 12),
    role: "admin",
  });

  console.log(`Initial admin created: ${normalisedEmail}`);
}

/**
 * Busca a quien intenta entrar por correo, WhatsApp o cedula. Un "09..." puede
 * ser a la vez celular y cedula de Guayas, por eso se buscan ambos y luego se
 * prueba la contraseña contra cada candidato.
 */
async function findLoginCandidates(identifier: string) {
  if (identifier.includes("@")) return UserModel.find({ email: normalizeEmail(identifier) }).limit(1);
  const phone = normalizePhone(identifier);
  const cedula = normalizeCedula(identifier);
  const or: Record<string, string>[] = [];
  if (phone) or.push({ phone });
  if (cedula) or.push({ cedula });
  return or.length ? UserModel.find({ $or: or }).limit(5) : [];
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    // `identifier` es el campo nuevo ("Correo, cédula o WhatsApp"); `email` se
    // mantiene para que un frontend sin actualizar siga entrando.
    const { identifier, email, password } = req.body ?? {};
    const value = String(identifier ?? email ?? "").trim();
    const secret = process.env.JWT_SECRET;

    if (!secret) throw new CustomError("Authentication is not configured", 503);
    if (!value || !password) {
      return res.status(400).json({ error: "Ingresa tu correo, cédula o WhatsApp y tu contraseña" });
    }

    let user = null;
    for (const candidate of await findLoginCandidates(value)) {
      if (await bcrypt.compare(String(password), candidate.passwordHash)) {
        user = candidate;
        break;
      }
    }

    if (!user) return res.status(401).json({ error: "Datos de acceso o contraseña incorrectos" });
    if (user.active === false) {
      return res.status(403).json({ error: "Tu acceso está desactivado. Pide a un administrador que lo active." });
    }

    const token = jwt.sign({ email: user.email || "", name: user.name, role: user.role || "admin" }, secret, {
      subject: user._id.toString(),
      // La sesion del panel se conserva en el navegador; el token dura 30 dias
      // para que el equipo no tenga que volver a ingresar cada jornada.
      expiresIn: "30d",
    });

    res.json({ token, user: userDto(user) });
  } catch (error) {
    next(error);
  }
}

export async function listUsers(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const users = await UserModel.find(ADMIN_FILTER).sort({ createdAt: -1 }).limit(200);
    res.json(users.map(userDto));
  } catch (error) {
    next(error);
  }
}

export async function createUser(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password || String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Nombre, correo y una contraseña de al menos ${MIN_PASSWORD_LENGTH} caracteres son obligatorios`,
      });
    }

    const normalisedEmail = String(email).trim().toLowerCase();

    if (await UserModel.exists({ email: normalisedEmail })) {
      return res.status(409).json({ error: "Ya existe un acceso con ese correo" });
    }

    const user = await UserModel.create({
      name: String(name).trim(),
      email: normalisedEmail,
      passwordHash: await bcrypt.hash(String(password), 12),
      role: "admin",
    });

    res.status(201).json(userDto(user));
  } catch (error) {
    next(error);
  }
}

export async function currentUser(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const user = await UserModel.findById(req.admin?.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(userDto(user));
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (req.params.id === req.admin?.id) {
      return res.status(400).json({ error: "No puedes eliminar tu propio acceso" });
    }
    const target = await UserModel.findById(req.params.id).select("role").lean();
    if (target && target.role !== "tecnico" && (await UserModel.countDocuments(ADMIN_FILTER)) <= 1) {
      return res.status(409).json({ error: "Debe quedar al menos un acceso al panel" });
    }

    const deleted = await UserModel.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Usuario no encontrado" });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

/* ---------------------------- Tecnicos ---------------------------- */

/**
 * Lee y normaliza los datos de acceso de un tecnico. Devuelve el error listo
 * para mostrar o los valores; `undefined` = no vino en el body (no se toca).
 */
function readTechnicianIdentity(body: Record<string, unknown>) {
  const read = (key: string, normalize: (value: unknown) => string) =>
    body[key] === undefined ? undefined : normalize(body[key]);

  const email = read("email", normalizeEmail);
  const phone = read("phone", normalizePhone);
  const cedula = read("cedula", normalizeCedula);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "El correo no es válido" };
  if (body.phone && !phone) return { error: "El WhatsApp no es válido. Ej.: 0991234567" };
  if (cedula && !isValidCedula(cedula)) return { error: "La cédula no es válida" };
  return { email, phone, cedula };
}

/** Ningun otro acceso puede tener el mismo correo, WhatsApp o cedula. */
async function identityTaken(values: { email?: string; phone?: string; cedula?: string }, exceptId?: string) {
  const labels = { email: "correo", phone: "WhatsApp", cedula: "cédula" } as const;
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    const value = values[key];
    if (!value) continue;
    const clash = await UserModel.exists({ [key]: value, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    if (clash) return `Ya existe un acceso con ese ${labels[key]}`;
  }
  return "";
}

export async function listTechnicians(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const users = await UserModel.find({ role: "tecnico" }).sort({ active: -1, name: 1 }).limit(200);
    res.json(users.map(userDto));
  } catch (error) {
    next(error);
  }
}

/** POST /api/auth/technicians { name, password, phone?, cedula?, email? } — al menos uno de los tres. */
export async function createTechnician(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    const password = String(body.password ?? "");
    if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` });
    }

    const identity = readTechnicianIdentity(body);
    if ("error" in identity) return res.status(400).json({ error: identity.error });
    const { email, phone, cedula } = identity;
    if (!email && !phone && !cedula) {
      return res.status(400).json({ error: "Agrega WhatsApp, cédula o correo: con eso entra al panel" });
    }

    const taken = await identityTaken({ email, phone, cedula });
    if (taken) return res.status(409).json({ error: taken });

    const user = await UserModel.create({
      name: name.slice(0, 120),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(cedula ? { cedula } : {}),
      passwordHash: await bcrypt.hash(password, 12),
      role: "tecnico",
      active: true,
    });

    res.status(201).json(userDto(user));
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/auth/technicians/:id { name?, phone?, cedula?, email?, active? } — "" borra el dato. */
export async function updateTechnician(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const user = await UserModel.findOne({ _id: req.params.id, role: "tecnico" });
    if (!user) return res.status(404).json({ error: "Técnico no encontrado" });

    const body = req.body ?? {};
    const identity = readTechnicianIdentity(body);
    if ("error" in identity) return res.status(400).json({ error: identity.error });

    const merged = {
      email: identity.email ?? user.email ?? "",
      phone: identity.phone ?? user.phone ?? "",
      cedula: identity.cedula ?? user.cedula ?? "",
    };
    if (!merged.email && !merged.phone && !merged.cedula) {
      return res.status(400).json({ error: "Debe quedar al menos WhatsApp, cédula o correo" });
    }
    const taken = await identityTaken(merged, user._id.toString());
    if (taken) return res.status(409).json({ error: taken });

    // Un dato vacio se elimina del documento (los indices unicos ignoran los ausentes).
    for (const key of ["email", "phone", "cedula"] as const) user.set(key, merged[key] || undefined);
    if (typeof body.name === "string" && body.name.trim()) user.name = body.name.trim().slice(0, 120);
    if (typeof body.active === "boolean") user.active = body.active;

    await user.save();
    res.json(userDto(user));
  } catch (error) {
    next(error);
  }
}

/** POST /api/auth/technicians/:id/password { password } */
export async function resetTechnicianPassword(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const password = String(req.body?.password ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` });
    }
    const user = await UserModel.findOne({ _id: req.params.id, role: "tecnico" });
    if (!user) return res.status(404).json({ error: "Técnico no encontrado" });

    user.passwordHash = await bcrypt.hash(password, 12);
    await user.save();
    res.json(userDto(user));
  } catch (error) {
    next(error);
  }
}
