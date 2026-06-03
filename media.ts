import { Router } from "express";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { requireAdmin } from "./admin.js";

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const CATEGORY_FOLDERS: Record<string, string> = {
  "main-news": "gpnews/main-news",
  "gulf-news": "gpnews/gulf-news",
  "kerala-news": "gpnews/kerala-news",
  "gp-special": "gpnews/gp-special",
  "live-stream": "gpnews/live-stream",
  "advertisements": "gpnews/advertisements",
  "backups": "gpnews/backups",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type"));
  },
});

// Upload a file
router.post("/media/upload", requireAdmin, upload.single("file"), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const category = (req.body.category as string) ?? "main-news";
    const folder = CATEGORY_FOLDERS[category] ?? "gpnews/main-news";
    const isVideo = req.file.mimetype.startsWith("video/");

    const uploadResult = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: isVideo ? "video" : "image",
          transformation: isVideo
            ? [{ quality: "auto", fetch_format: "mp4" }]
            : [{ quality: "auto", fetch_format: "auto" }, { width: 1600, height: 1067, crop: "limit" }],
          eager: isVideo ? [] : [{ width: 400, height: 267, crop: "fill", gravity: "auto" }],
          eager_async: false,
        },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(req.file!.buffer);
    });

    return res.json({
      url: uploadResult.secure_url,
      thumbnailUrl: uploadResult.eager?.[0]?.secure_url ?? uploadResult.secure_url,
      publicId: uploadResult.public_id,
      resourceType: uploadResult.resource_type,
      format: uploadResult.format,
      width: uploadResult.width,
      height: uploadResult.height,
      bytes: uploadResult.bytes,
      folder,
      createdAt: uploadResult.created_at,
    });
  } catch (err: any) {
    req.log?.error(err, "Media upload failed");
    return res.status(500).json({ error: err.message ?? "Upload failed" });
  }
});

// List all gpnews sub-folders
router.get("/media/folders", requireAdmin, async (_req: any, res: any) => {
  try {
    const result = await cloudinary.api.sub_folders("gpnews");
    return res.json({ folders: result.folders ?? [] });
  } catch (err: any) {
    // If root folder doesn't exist yet return empty
    return res.json({ folders: [] });
  }
});

// List assets in a folder
router.get("/media/assets", requireAdmin, async (req: any, res: any) => {
  try {
    const folder = (req.query.folder as string) ?? "gpnews/main-news";
    const resourceType = (req.query.type as string) ?? "image";
    const nextCursor = req.query.next_cursor as string | undefined;

    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: folder + "/",
      resource_type: resourceType as any,
      max_results: 30,
      next_cursor: nextCursor,
    });

    const assets = (result.resources ?? []).map((r: any) => ({
      publicId: r.public_id,
      url: r.secure_url,
      thumbnailUrl: cloudinary.url(r.public_id, { width: 200, height: 140, crop: "fill", quality: "auto", fetch_format: "auto", secure: true }),
      format: r.format,
      resourceType: r.resource_type,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      createdAt: r.created_at,
      folder: r.folder ?? folder,
    }));

    return res.json({ assets, nextCursor: result.next_cursor ?? null, total: result.total_count ?? assets.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Failed to list assets" });
  }
});

// Delete a single asset
router.delete("/media/asset", requireAdmin, async (req: any, res: any) => {
  try {
    const { publicId, resourceType = "image" } = req.body;
    if (!publicId) return res.status(400).json({ error: "publicId required" });
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return res.json({ deleted: result.result === "ok", result: result.result });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Delete failed" });
  }
});

// Bulk delete assets in a folder (daily cleanup)
router.delete("/media/folder", requireAdmin, async (req: any, res: any) => {
  try {
    const { folder } = req.body;
    if (!folder) return res.status(400).json({ error: "folder required" });
    const result = await cloudinary.api.delete_resources_by_prefix(folder + "/");
    return res.json({ deleted: result.deleted, partial: result.partial });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Bulk delete failed" });
  }
});

// Health check — admin only (triggers authenticated Cloudinary API call)
router.get("/media/health", requireAdmin, async (_req, res) => {
  try {
    await cloudinary.api.ping();
    return res.json({ status: "ok", provider: "cloudinary" });
  } catch (err: any) {
    return res.status(503).json({ status: "error", error: err.message });
  }
});

export default router;
