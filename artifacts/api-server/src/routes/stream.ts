import { Router, type IRouter } from "express";
import https from "https";
import http from "http";
import { URL } from "url";
import type { IncomingMessage } from "http";

const router: IRouter = Router();

const ALLOWED_CDN_HOSTS = [
  "xvideos-cdn.com",
  "xvideos.com",
  "pornhub.com",
  "phncdn.com",
];

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.5",
  Cookie: "age_verified=1; ageGate=true; confirm=1",
};

function isAllowedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_CDN_HOSTS.some((host) => parsed.hostname.endsWith(host));
  } catch {
    return false;
  }
}

function fetchUrl(
  rawUrl: string,
  extraHeaders: Record<string, string> = {}
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      rawUrl,
      { headers: { ...BASE_HEADERS, ...extraHeaders }, method: "GET" },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchText(
  rawUrl: string,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  const res = await fetchUrl(rawUrl, extraHeaders);
  return new Promise((resolve, reject) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (body += chunk));
    res.on("end", () => resolve(body));
    res.on("error", reject);
  });
}

function resolveHlsUrl(line: string, baseUrl: string): string {
  try {
    return new URL(line, baseUrl).href;
  } catch {
    return line;
  }
}

function parseMasterPlaylist(text: string, baseUrl: string): string | null {
  const lines = text.split("\n").map((l) => l.trim());
  const streams: { bandwidth: number; url: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const next = lines[i + 1] || "";
      if (next && !next.startsWith("#")) {
        streams.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          url: resolveHlsUrl(next, baseUrl),
        });
      }
    }
  }
  if (streams.length === 0) return null;
  // Pick lowest bandwidth variant to keep response size small
  streams.sort((a, b) => a.bandwidth - b.bandwidth);
  return streams[0].url;
}

function parseSegments(text: string, baseUrl: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => resolveHlsUrl(l, baseUrl));
}

router.get("/stream/video.mp4", async (req, res) => {
  const rawUrl = req.query["url"] as string | undefined;
  const referer = req.query["ref"] as string | undefined;

  if (!rawUrl || !isAllowedUrl(rawUrl)) {
    res.status(400).json({ error: "Missing or disallowed url parameter" });
    return;
  }

  const extraHeaders: Record<string, string> = {};
  if (referer) {
    try {
      const refOrigin = new URL(referer);
      extraHeaders["Referer"] = referer;
      extraHeaders["Origin"] = `${refOrigin.protocol}//${refOrigin.host}`;
    } catch {}
  }

  const isHls = rawUrl.includes(".m3u8") || rawUrl.includes("hls");

  if (isHls) {
    // ── HLS proxy: fetch segments and pipe them back as MPEG-TS ──────────────
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Content-Disposition", 'inline; filename="video.ts"');
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Transfer-Encoding", "chunked");
    res.status(200);

    try {
      let playlistUrl = rawUrl;
      const masterText = await fetchText(rawUrl, extraHeaders);

      if (masterText.includes("#EXT-X-STREAM-INF")) {
        const variantUrl = parseMasterPlaylist(masterText, rawUrl);
        if (!variantUrl) {
          res.end();
          return;
        }
        playlistUrl = variantUrl;
      }

      const variantText =
        playlistUrl === rawUrl
          ? masterText
          : await fetchText(playlistUrl, extraHeaders);
      const segments = parseSegments(variantText, playlistUrl);

      // Stream up to 75 seconds worth of segments (approx 30 segments at 2s each)
      const MAX_SEGMENTS = 38;
      const toStream = segments.slice(0, MAX_SEGMENTS);

      for (const segUrl of toStream) {
        if (res.destroyed) break;
        try {
          const segRes = await fetchUrl(segUrl, extraHeaders);
          await new Promise<void>((resolve, reject) => {
            segRes.on("data", (chunk: Buffer) => {
              if (!res.destroyed) res.write(chunk);
            });
            segRes.on("end", resolve);
            segRes.on("error", reject);
          });
        } catch {
          // skip failed segment
        }
      }
      res.end();
    } catch (err: unknown) {
      if (!res.headersSent) {
        res
          .status(502)
          .json({
            error: "HLS proxy failed",
            detail: err instanceof Error ? err.message : String(err),
          });
      } else {
        res.end();
      }
    }
    return;
  }

  // ── Direct MP4 proxy ───────────────────────────────────────────────────────
  const parsed = new URL(rawUrl);
  const lib = parsed.protocol === "https:" ? https : http;

  const upstream = lib.request(
    rawUrl,
    { headers: { ...BASE_HEADERS, ...extraHeaders }, method: "GET" },
    (upRes) => {
      if (upRes.statusCode && upRes.statusCode >= 400) {
        res.status(502).json({ error: `Upstream returned ${upRes.statusCode}` });
        upRes.resume();
        return;
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'inline; filename="video.mp4"');
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
      res
        .status(502)
        .json({ error: "Upstream request failed", detail: err.message });
    }
  });

  req.on("close", () => upstream.destroy());
  upstream.end();
});

export default router;
