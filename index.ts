import { Router, type IRouter } from "express";
import healthRouter from "./health";
import articlesRouter from "./articles";
import categoriesRouter from "./categories";
import breakingRouter from "./breaking";
import adminRouter from "./admin";
import statsRouter from "./stats";
import mediaRouter from "./media";
import systemRouter from "./system";
import driveRouter from "./drive";
import aiNewsRouter from "./ai-news";
import communityRouter from "./community";
import siteRouter from "./site";
import ratesRouter from "./rates";
import socialRouter from "./social";
import assistantRouter from "./assistant";

const router: IRouter = Router();

router.use(healthRouter);
router.use(articlesRouter);
router.use(categoriesRouter);
router.use(breakingRouter);
router.use(adminRouter);
router.use(statsRouter);
router.use(mediaRouter);
router.use(systemRouter);
router.use(driveRouter);
router.use(aiNewsRouter);
router.use(communityRouter);
router.use(siteRouter);
router.use(ratesRouter);
router.use(socialRouter);
router.use(assistantRouter);

export default router;
