import { NextFunction, Request, Response } from "express";
import { UploadApiResponse } from "cloudinary";
import cloudinary from "../config/cloudinary";

export async function uploadCatalogImage(req: Request, res: Response, next: NextFunction) {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Image file is required" });

  try {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "megaprinter/catalog", resource_type: "image", transformation: [{ quality: "auto", fetch_format: "auto" }] },
        (error, upload) => error || !upload ? reject(error || new Error("Cloudinary upload failed")) : resolve(upload)
      );
      stream.end(file.buffer);
    });
    res.status(201).json({ url: result.secure_url, publicId: result.public_id });
  } catch (error) { next(error); }
}
