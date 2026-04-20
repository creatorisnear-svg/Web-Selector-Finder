import { Router, type IRouter } from "express";
import https from "https";
import http from "http";
import { URL } from "url";

const router: IRouter = Router();

const ALLOWED_CDN_HOSTS = [
  "xvideos-cdn.com",
  "xvideos.com",
  "pornhub.com",
  "phncdn.com",
];

function isAllowedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_CDN_HOSTS.some((host) => parsed.hostname.endsWith(host));
  } catch {
    return false;
  }
}

router.get("/stream/video.mp4", (req, res) => {
  const rawUrl = req.query["url"] as string | undefined;
  const referer = req.query["ref"] as string | undefined;

  if (!rawUrl || !isAllowedUrl(rawUrl)) {
    res.status(400).json({ error: "Missing or disallowed url parameter" });
    return;
  }

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    Cookie: "age_verified=1; ageGate=true; confirm=1",
  };
  if (referer) {
    try {
      const refOrigin = new URL(referer);
      headers["Referer"] = referer;
      headers["Origin"] = `${refOrigin.protocol}//${refOrigin.host}`;
    } catch {}
  }

  const parsed = new URL(rawUrl);
  const lib = parsed.protocol === "https:" ? https : http;

  const upstream = lib.request(
    rawUrl,
    { headers, method: "GET" },
    (upRes) => {
      if (upRes.statusCode && upRes.statusCode >= 400) {
        res.status(502).json({ error: `Upstream returned ${upRes.statusCode}` });
        upRes.resume();
        return;
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "inline; filename=\"video.mp4\"");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "no-store");

      const contentLength = upRes.headers["content-length"];
      if (contentLength) res.setHeader("Content-Length", contentLength);

      const contentRange = upRes.headers["content-range"];
      if (contentRange) res.setHeader("Content-Range", contentRange);

      res.status(upRes.statusCode || 200);
      upRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "Upstream request failed", detail: err.message });
    }
  });

  req.on("close", () => upstream.destroy());
  upstream.end();
});

export default router;
