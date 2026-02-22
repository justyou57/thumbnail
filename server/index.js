import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import archiver from "archiver";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
const thumbsDir = path.join(__dirname, "thumbs");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/\s+/g, "_");
        cb(null, `${Date.now()}_${safe}`);
    },
});
const upload = multer({ storage });

function safeJoin(base, fileName) {
    const full = path.resolve(base, fileName);
    const baseResolved = path.resolve(base);
    if (!full.startsWith(baseResolved + path.sep) && full !== baseResolved) {
        throw new Error("Invalid path");
    }
    return full;
}

function runExecFile(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        });
    });
}

async function ffprobeDurationSeconds(inputPath) {
    const { stdout } = await runExecFile("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputPath,
    ]);
    const n = Number(String(stdout).trim());
    if (!Number.isFinite(n)) throw new Error("Bad duration");
    return n;
}

async function extractJpgAt(videoPath, tsSeconds, outPath, width = null) {
    const vf = width ? ["-vf", `scale=${width}:-1`] : [];
    await runExecFile("ffmpeg", [
        "-y",
        "-ss",
        String(tsSeconds),
        "-i",
        videoPath,
        ...vf,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        outPath,
    ]);
}

/**
 * Score a still image using FFmpeg only (no ImageMagick dependency).
 * We compute:
 * - exposure: prefer mid brightness
 * - contrast: prefer not-flat
 * - sharpness proxy: edge strength (edgedetect + signalstats)
 */
function parseSignalstats(stderr) {
    // FFmpeg prints lines containing: lavfi.signalstats.YAVG=... YSTD=... etc
    // Depending on build, it might show as metadata lines.
    const out = {};
    const re = /lavfi\.signalstats\.([A-Z]+)=([0-9.]+)/g;
    let m;
    while ((m = re.exec(stderr)) !== null) {
        out[m[1]] = Number(m[2]);
    }
    return out; // values are 0..255-ish
}

async function scoreFrameJpg(jpgPath) {
    // Pass 1: brightness + contrast
    let baseStats = {};
    try {
        const { stderr } = await runExecFile("ffmpeg", [
            "-i",
            jpgPath,
            "-vf",
            "format=gray,signalstats,metadata=print",
            "-f",
            "null",
            "-",
        ]);
        baseStats = parseSignalstats(stderr);
    } catch {
        return 0.0;
    }

    // Pass 2: edge strength (sharpness proxy)
    let edgeStats = {};
    try {
        const { stderr } = await runExecFile("ffmpeg", [
            "-i",
            jpgPath,
            "-vf",
            "format=gray,edgedetect=mode=colormix:low=0.1:high=0.4,signalstats,metadata=print",
            "-f",
            "null",
            "-",
        ]);
        edgeStats = parseSignalstats(stderr);
    } catch {
        edgeStats = {};
    }

    const yavg = Number.isFinite(baseStats.YAVG) ? baseStats.YAVG : 128; // 0..255
    const ystd = Number.isFinite(baseStats.YSTD) ? baseStats.YSTD : 0;   // 0..255-ish
    const edge = Number.isFinite(edgeStats.YAVG) ? edgeStats.YAVG : 0;   // 0..255

    // Normalize 0..1
    const exposure = 1 - Math.min(1, Math.abs(yavg - 128) / 128);     // best near 128
    const contrast = Math.min(1, ystd / 64);                          // 64 is “good enough”
    const sharp = Math.min(1, edge / 40);                             // edges tend to be smaller

    // Weighted score
    const score = exposure * 0.45 + contrast * 0.30 + sharp * 0.25;
    return score;
}

function uniqueWithGap(sortedTimes, minGapSeconds) {
    const out = [];
    for (const t of sortedTimes) {
        if (out.length === 0 || Math.abs(t - out[out.length - 1]) >= minGapSeconds) out.push(t);
    }
    return out;
}

function makeCandidateTimes(duration, maxCandidates = 180) {
    // Avoid first/last 6% (black frames / cuts)
    const start = duration * 0.06;
    const end = duration * 0.94;
    const span = Math.max(0, end - start);

    const count = Math.min(maxCandidates, Math.max(40, Math.floor(duration / 0.35)));
    const step = span / (count + 1);

    const times = [];
    for (let i = 1; i <= count; i++) {
        const t = start + step * i;
        times.push(Math.max(0, Math.min(duration - 0.15, t)));
    }
    return times;
}

async function autoPickTop5Times(videoPath) {
    const duration = await ffprobeDurationSeconds(videoPath);
    const candidates = makeCandidateTimes(duration, 180);

    // temp frames for scoring
    const tmpDir = path.join(os.tmpdir(), `top5_score_${process.pid}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const scored = [];
    try {
        for (let i = 0; i < candidates.length; i++) {
            const ts = candidates[i];
            const jpg = path.join(tmpDir, `c_${i}_${ts.toFixed(2)}.jpg`);

            // small extraction for faster scoring
            await extractJpgAt(videoPath, ts, jpg, 320);

            const s = await scoreFrameJpg(jpg);
            scored.push({ ts, score: s });

            try { fs.unlinkSync(jpg); } catch { }
        }
    } finally {
        try { fs.rmdirSync(tmpDir, { recursive: true }); } catch { }
    }

    // Sort best-first
    scored.sort((a, b) => b.score - a.score);

    // Pick top 5 but keep them spread out in time (avoid near-duplicates)
    const picks = [];
    const minGap = Math.max(1.2, duration * 0.06); // dynamic gap
    for (const item of scored) {
        if (picks.length >= 5) break;
        if (picks.every((p) => Math.abs(p.ts - item.ts) >= minGap)) {
            picks.push(item);
        }
    }

    // If not enough due to gap rule, relax gap
    if (picks.length < 5) {
        for (const item of scored) {
            if (picks.length >= 5) break;
            if (picks.every((p) => Math.abs(p.ts - item.ts) >= 1.0)) {
                picks.push(item);
            }
        }
    }

    // Final sort chronologically (looks nicer in filenames)
    picks.sort((a, b) => a.ts - b.ts);

    return { duration, picks };
}

/** ------------------ ROUTES ------------------ **/

// Upload
app.post("/api/upload", upload.single("video"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ ok: true, videoId: req.file.filename });
});

// Serve raw video
app.get("/api/video/:id", (req, res) => {
    try {
        const p = safeJoin(uploadsDir, req.params.id);
        if (!fs.existsSync(p)) return res.status(404).end();
        res.sendFile(p);
    } catch {
        res.status(400).end();
    }
});

// Manual thumbnail
// GET /api/thumbnail/:id?ts=2.5 OR ?ts=mid
app.get("/api/thumbnail/:id", async (req, res) => {
    try {
        const videoPath = safeJoin(uploadsDir, req.params.id);
        if (!fs.existsSync(videoPath)) return res.status(404).json({ error: "Video not found" });

        const tsParam = (req.query.ts || "mid").toString();
        let ssSeconds = 0;

        if (tsParam === "mid") {
            const dur = await ffprobeDurationSeconds(videoPath);
            ssSeconds = Math.max(0, dur * 0.5);
        } else {
            const n = Number(tsParam);
            ssSeconds = Number.isFinite(n) ? Math.max(0, n) : 0;
        }

        const outName = `${req.params.id}__${String(ssSeconds).replace(".", "_")}.jpg`;
        const outPath = safeJoin(thumbsDir, outName);

        if (!fs.existsSync(outPath)) {
            await extractJpgAt(videoPath, ssSeconds, outPath);
        }

        res.setHeader("Content-Type", "image/jpeg");
        res.sendFile(outPath);
    } catch (e) {
        res.status(500).json({ error: "Thumbnail failed", detail: String(e?.message || e) });
    }
});

// Top 5 ZIP
app.get("/api/top5-zip/:id", async (req, res) => {
    try {
        const videoId = req.params.id;
        const videoPath = safeJoin(uploadsDir, videoId);
        if (!fs.existsSync(videoPath)) return res.status(404).json({ error: "Video not found" });

        const { picks } = await autoPickTop5Times(videoPath);

        const tmpDir = path.join(os.tmpdir(), `top5_${process.pid}_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        const files = [];
        for (let i = 0; i < Math.min(5, picks.length); i++) {
            const ts = picks[i].ts;
            const score = picks[i].score;
            const out = path.join(tmpDir, `thumb_${i + 1}_${ts.toFixed(2)}s_score_${score.toFixed(3)}.jpg`);
            await extractJpgAt(videoPath, ts, out);
            files.push(out);
        }

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${videoId}_top5_thumbs.zip"`);

        const archive = archiver("zip", { zlib: { level: 9 } });
        archive.on("error", (err) => {
            try { res.status(500).end(String(err)); } catch { }
        });

        archive.pipe(res);
        for (const f of files) archive.file(f, { name: path.basename(f) });
        await archive.finalize();

        res.on("finish", () => {
            try {
                for (const f of files) fs.unlinkSync(f);
                fs.rmdirSync(tmpDir, { recursive: true });
            } catch { }
        });
    } catch (e) {
        res.status(500).json({ error: "top5 zip failed", detail: String(e?.message || e) });
    }
});

// Caption from video (extract a few frames -> OpenAI vision -> return caption JSON)
app.get("/api/caption/:id", async (req, res) => {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return res.status(400).json({ error: "Missing OPENAI_API_KEY in server/.env" });

        const style = String(req.query.style || "viral").toLowerCase(); // viral | professional | islamic | simple
        const videoId = req.params.id;
        const videoPath = safeJoin(uploadsDir, videoId);
        if (!fs.existsSync(videoPath)) return res.status(404).json({ error: "Video not found" });

        const client = new OpenAI({ apiKey });

        // Reuse our best-pick logic; use 3 frames for caption (faster/cheaper than 5)
        const { picks } = await autoPickTop5Times(videoPath);
        const chosen = picks.slice(0, 3).map((p) => p.ts);

        const tmpDir = path.join(os.tmpdir(), `caption_${process.pid}_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        const framePaths = [];
        for (let i = 0; i < chosen.length; i++) {
            const out = path.join(tmpDir, `cap_${i + 1}_${chosen[i].toFixed(2)}.jpg`);
            await extractJpgAt(videoPath, chosen[i], out);
            framePaths.push(out);
        }

        // Upload frames to OpenAI as vision files
        const fileIds = [];
        for (const p of framePaths) {
            const file = await client.files.create({
                file: fs.createReadStream(p),
                purpose: "vision",
            });
            fileIds.push(file.id);
        }

        const styleGuide = {
            viral:
                "Write a short high-engagement caption. Hook first line. 1–2 short paragraphs. End with 3–8 relevant hashtags. No cringe.",
            professional:
                "Write a clean professional caption. Clear value, no slang. End with 3–6 hashtags.",
            islamic:
                "Write a respectful uplifting caption. Avoid aggressive claims. Keep it concise. Add 2–6 hashtags.",
            simple:
                "Write a very simple caption. 1–2 sentences. 0–3 hashtags.",
        }[style] || "Write a strong caption with a hook and a few hashtags.";

        const response = await client.responses.create({
            model: "gpt-4.1-mini",
            input: [
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: `Create a caption based on these video frames.\n\nStyle rules:\n${styleGuide}\n\nReturn ONLY valid JSON in this exact shape:\n{\n  "hook": "...",\n  "caption": "...",\n  "hashtags": ["#..."]\n}\n` },
                        ...fileIds.map((id) => ({ type: "input_image", file_id: id })),
                    ],
                },
            ],
        });

        // The model returns text; we want JSON
        const text = (response.output_text || "").trim();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            // fallback: wrap raw
            json = { hook: "", caption: text, hashtags: [] };
        }

        // cleanup local temp files
        try {
            for (const p of framePaths) fs.unlinkSync(p);
            fs.rmdirSync(tmpDir, { recursive: true });
        } catch { }

        res.json({ ok: true, videoId, style, ...json });
    } catch (e) {
        res.status(500).json({ error: "caption failed", detail: String(e?.message || e) });
    }
});

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(5050, () => console.log("API running on http://localhost:5050"));