import { Router } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { requireAdmin } from "./admin.js";

const router = Router();
const connectors = new ReplitConnectors();

const DRIVE_FOLDER_ID = "1hV93JXt9gMKOeU-B9uO99CVeSRyjg39N";

// List files in the shared Google Drive folder (or a sub-folder)
router.get("/drive/files", requireAdmin, async (req: any, res: any) => {
  try {
    const folderId = (req.query.folderId as string) ?? DRIVE_FOLDER_ID;
    const pageToken = req.query.pageToken as string | undefined;

    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink,webContentLink,createdTime,modifiedTime,iconLink)",
      orderBy: "modifiedTime desc",
      pageSize: "30",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await connectors.proxy("google-drive", `/drive/v3/files?${params}`, {
      method: "GET",
    });

    const data = await response.json() as any;

    if (data.error) {
      return res.status(400).json({ error: data.error.message ?? "Drive API error" });
    }

    const files = (data.files ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? parseInt(f.size) : 0,
      thumbnailLink: f.thumbnailLink ?? null,
      webViewLink: f.webViewLink ?? null,
      webContentLink: f.webContentLink ?? null,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      iconLink: f.iconLink ?? null,
      isFolder: f.mimeType === "application/vnd.google-apps.folder",
    }));

    return res.json({ files, nextPageToken: data.nextPageToken ?? null });
  } catch (err: any) {
    req.log?.error(err, "Google Drive list failed");
    return res.status(500).json({ error: err.message ?? "Failed to list Drive files" });
  }
});

// Get download/direct link for a file (to upload to Cloudinary)
router.post("/drive/import", requireAdmin, async (req: any, res: any) => {
  try {
    const { fileId, fileName } = req.body;
    if (!fileId) return res.status(400).json({ error: "fileId required" });

    // Get file metadata first
    const metaRes = await connectors.proxy("google-drive", `/drive/v3/files/${fileId}?fields=id,name,mimeType,size,webContentLink`, { method: "GET" });
    const meta = await metaRes.json() as any;

    if (meta.error) return res.status(400).json({ error: meta.error.message });

    // Download the file content
    const dlRes = await connectors.proxy("google-drive", `/drive/v3/files/${fileId}?alt=media`, { method: "GET" });
    const buffer = Buffer.from(await dlRes.arrayBuffer());

    // Upload to Cloudinary
    const { v2: cloudinary } = await import("cloudinary");
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });

    const isVideo = meta.mimeType?.startsWith("video/");
    const uploadResult = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "gpnews/main-news",
          resource_type: isVideo ? "video" : "image",
          transformation: isVideo
            ? [{ quality: "auto" }]
            : [{ quality: "auto", fetch_format: "auto" }, { width: 1600, height: 1067, crop: "limit" }],
          public_id: (fileName ?? meta.name ?? fileId).replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]/gi, "_"),
        },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(buffer);
    });

    return res.json({
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      width: uploadResult.width,
      height: uploadResult.height,
      bytes: uploadResult.bytes,
      folder: "gpnews/main-news",
      source: "google-drive",
      driveFileId: fileId,
    });
  } catch (err: any) {
    req.log?.error(err, "Drive import failed");
    return res.status(500).json({ error: err.message ?? "Import failed" });
  }
});

export default router;
