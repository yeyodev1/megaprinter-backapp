import { Request, Response, NextFunction } from "express";
import { ErrorHandler } from "../errors/errorHandler.error";

const slackWebhookUrl = process.env.SLACK_ERROR_WEBHOOK || "";
const handler = new ErrorHandler(slackWebhookUrl);

interface NormalisedError {
  status: number;
  message: string;
  details?: unknown;
}

/**
 * Traduce los errores de Mongoose a codigos HTTP con sentido. Antes todos
 * llegaban al cliente como 500: un producto sin campos obligatorios, un id mal
 * formado o una categoria duplicada eran indistinguibles de una caida real del
 * servidor.
 */
function normalise(error: any): NormalisedError {
  if (error?.name === "ValidationError") {
    const fields = Object.values(error.errors ?? {}).map((item: any) => item.message);
    return {
      status: 400,
      message: fields.length ? fields.join(". ") : "Datos inválidos",
      details: fields,
    };
  }

  if (error?.name === "CastError") {
    return { status: 400, message: `Identificador inválido: ${error.value}` };
  }

  if (error?.code === 11000) {
    const field = Object.keys(error.keyValue ?? {}).join(", ") || "registro";
    return { status: 409, message: `Ya existe un registro con ese ${field}` };
  }

  return {
    status: error?.status || error?.statusCode || 500,
    message: error?.message || "Internal Server Error",
    details: error?.details,
  };
}

export function globalErrorHandler(
  error: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const { status, message, details } = normalise(error);
  handler.handleHttpError(res, message, status, { ...error, details, stack: error?.stack });
}
