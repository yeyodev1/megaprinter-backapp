import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { UserModel } from "../models/user.model";
import { AdminRequest } from "../middlewares/admin.middleware";
import { CustomError } from "../errors/customError.error";

const MIN_PASSWORD_LENGTH = 8;

const userDto = (user: {
  _id: { toString(): string };
  name: string;
  email: string;
  role: string;
  createdAt?: Date;
}) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt,
});

export async function ensureInitialAdmin() {
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

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;
    const secret = process.env.JWT_SECRET;

    if (!secret) throw new CustomError("Authentication is not configured", 503);
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son obligatorios" });
    }

    const user = await UserModel.findOne({ email: String(email).trim().toLowerCase() });

    if (!user || !(await bcrypt.compare(String(password), user.passwordHash))) {
      return res.status(401).json({ error: "Correo o contraseña incorrectos" });
    }

    const token = jwt.sign({ email: user.email, role: user.role }, secret, {
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
    const users = await UserModel.find().sort({ createdAt: -1 }).limit(200);
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
    if ((await UserModel.countDocuments()) <= 1) {
      return res.status(409).json({ error: "Debe quedar al menos un acceso al panel" });
    }

    const deleted = await UserModel.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Usuario no encontrado" });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
