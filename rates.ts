import { Router } from "express";
import { getRates } from "../lib/rates-service.js";

const router = Router();

// Public: live currency rates for the header ticker (Gulf currencies → INR).
router.get("/rates", async (req: any, res: any) => {
  try {
    const data = await getRates();
    if (!data) return res.status(503).json({ error: "Rates unavailable" });
    res.set("Cache-Control", "public, max-age=300");
    return res.json(data);
  } catch (err: any) {
    req.log?.error(err, "Get rates failed");
    return res.status(500).json({ error: "Failed to load rates" });
  }
});

export default router;
