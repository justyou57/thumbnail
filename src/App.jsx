import { useMemo, useState } from "react";

const API = "http://localhost:5050";

export default function App() {
  const [file, setFile] = useState(null);
  const [videoId, setVideoId] = useState("");
  const [uploading, setUploading] = useState(false);

  const [duration, setDuration] = useState(0);
  const [ts, setTs] = useState(2.5);

  const [zipLoading, setZipLoading] = useState(false);

  const [captionStyle, setCaptionStyle] = useState("viral");
  const [captionLoading, setCaptionLoading] = useState(false);
  const [captionData, setCaptionData] = useState(null);

  const thumbUrl = useMemo(() => {
    if (!videoId) return "";
    return `${API}/api/thumbnail/${encodeURIComponent(videoId)}?ts=${ts}&cb=${Date.now()}`;
  }, [videoId, ts]);

  const videoUrl = useMemo(() => {
    if (!videoId) return "";
    return `${API}/api/video/${encodeURIComponent(videoId)}`;
  }, [videoId]);

  async function uploadVideo() {
    if (!file) return;

    setUploading(true);
    setCaptionData(null);

    try {
      const form = new FormData();
      form.append("video", file);

      const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Upload failed");

      setVideoId(data.videoId);
    } catch (e) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  }

  function onLoadedMetadata(e) {
    const d = e.target.duration || 0;
    setDuration(d);
    if (d > 0) setTs(Number((d * 0.5).toFixed(2)));
  }

  function downloadCurrentThumb() {
    if (!thumbUrl) return;
    const a = document.createElement("a");
    a.href = thumbUrl;
    a.download = `${videoId || "thumb"}_${ts}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadTop5Zip() {
    if (!videoId) return;

    // IMPORTANT:
    // Browser downloads are most reliable when triggered by a direct user click.
    // This uses a normal navigation download (NOT fetch->json).
    setZipLoading(true);
    try {
      const url = `${API}/api/top5-zip/${encodeURIComponent(videoId)}?cb=${Date.now()}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = `${videoId}_top5_thumbs.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => setZipLoading(false), 800);
    }
  }

  async function generateCaption() {
    if (!videoId) return;
    setCaptionLoading(true);
    setCaptionData(null);

    try {
      const url = `${API}/api/caption/${encodeURIComponent(videoId)}?style=${encodeURIComponent(captionStyle)}&cb=${Date.now()}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) throw new Error(data?.error || "Caption failed");

      setCaptionData(data);
    } catch (e) {
      alert(e.message);
    } finally {
      setCaptionLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "40px auto", padding: 16, fontFamily: "system-ui, -apple-system" }}>
      <h1 style={{ marginBottom: 6 }}>Video → Thumbnail + Caption</h1>
      <p style={{ marginTop: 0, opacity: 0.75 }}>
        Upload a video, scrub a thumbnail, auto-pick top 5 (ZIP), and generate a caption.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
        <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />

        <button
          onClick={uploadVideo}
          disabled={!file || uploading}
          style={{ padding: "10px 14px", cursor: uploading ? "not-allowed" : "pointer" }}
        >
          {uploading ? "Uploading..." : "Upload"}
        </button>

        {videoId ? (
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            videoId: <code>{videoId}</code>
          </span>
        ) : null}
      </div>

      {videoId ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          {/* Video + Controls */}
          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Preview</h3>
            <video
              src={videoUrl}
              controls
              style={{ width: "100%", borderRadius: 8, background: "#000" }}
              onLoadedMetadata={onLoadedMetadata}
            />

            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.75 }}>
                <span>Time (seconds)</span>
                <span>
                  {ts}s {duration ? `(max ${duration.toFixed(2)}s)` : ""}
                </span>
              </div>

              <input
                type="range"
                min={0}
                max={duration || 30}
                step={0.1}
                value={ts}
                onChange={(e) => setTs(Number(e.target.value))}
                style={{ width: "100%" }}
              />

              <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                <button onClick={() => setTs(0)} style={{ padding: "8px 10px" }}>Start</button>
                <button
                  onClick={() => duration && setTs(Number((duration * 0.5).toFixed(2)))}
                  style={{ padding: "8px 10px" }}
                  disabled={!duration}
                >
                  Middle
                </button>
                <button
                  onClick={() => duration && setTs(Number((Math.max(0, duration - 0.1)).toFixed(2)))}
                  style={{ padding: "8px 10px" }}
                  disabled={!duration}
                >
                  End
                </button>
              </div>

              <hr style={{ margin: "16px 0", opacity: 0.3 }} />

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={downloadTop5Zip}
                  disabled={zipLoading}
                  style={{ padding: "10px 14px" }}
                >
                  {zipLoading ? "Preparing ZIP..." : "Download Top 5 ZIP"}
                </button>

                <select
                  value={captionStyle}
                  onChange={(e) => setCaptionStyle(e.target.value)}
                  style={{ padding: "10px 12px" }}
                >
                  <option value="viral">Viral</option>
                  <option value="professional">Professional</option>
                  <option value="islamic">Islamic</option>
                  <option value="simple">Simple</option>
                </select>

                <button
                  onClick={generateCaption}
                  disabled={captionLoading}
                  style={{ padding: "10px 14px" }}
                >
                  {captionLoading ? "Generating..." : "Generate Caption"}
                </button>
              </div>

              {captionData ? (
                <div style={{ marginTop: 14, padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Caption Output</div>
                  {captionData.hook ? (
                    <>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>{captionData.hook}</div>
                    </>
                  ) : null}
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{captionData.caption}</div>
                  {Array.isArray(captionData.hashtags) && captionData.hashtags.length ? (
                    <div style={{ marginTop: 10, opacity: 0.85 }}>
                      {captionData.hashtags.join(" ")}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* Thumbnail */}
          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Thumbnail (scrubbed)</h3>

            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt="thumbnail"
                style={{ width: "100%", borderRadius: 8, border: "1px solid #eee" }}
              />
            ) : (
              <div style={{ padding: 20, opacity: 0.6 }}>No thumbnail yet</div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button onClick={downloadCurrentThumb} style={{ padding: "10px 14px" }}>
                Download JPG (Current)
              </button>
              <a href={thumbUrl} target="_blank" rel="noreferrer" style={{ padding: "10px 14px", display: "inline-block" }}>
                Open image
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 30, opacity: 0.7 }}>
          Upload a video to begin.
        </div>
      )}
    </div>
  );
}