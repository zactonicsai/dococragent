const express = require("express");
const multer = require("multer");
const cors = require("cors");
const mime = require("mime-types");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
const PORT = 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || "http://ocr:5000";

// Ensure upload directories exist
const originalsDir = path.join(UPLOAD_DIR, "originals");
const textDir = path.join(UPLOAD_DIR, "text");
fs.mkdirSync(originalsDir, { recursive: true });
fs.mkdirSync(textDir, { recursive: true });

app.use(cors());
app.use(express.json());

// ─── Multer storage config ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, originalsDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${timestamp}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ─── Image MIME types that trigger OCR ───
const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/tiff",
  "image/bmp",
  "image/gif",
  "image/webp",
];

// ─── PDF also gets OCR ───
const OCR_TYPES = [...IMAGE_TYPES, "application/pdf"];

// ─── Upload endpoint ───
app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.file;
    const detectedMime = mime.lookup(file.originalname) || file.mimetype;
    const isOcrType = OCR_TYPES.includes(detectedMime);

    const result = {
      filename: file.filename,
      originalName: file.originalname,
      mimeType: detectedMime,
      size: file.size,
      isImage: IMAGE_TYPES.includes(detectedMime),
      isPdf: detectedMime === "application/pdf",
      ocrApplied: false,
      extractedText: null,
      storedPath: file.path,
    };

    // If image or PDF, call OCR service
    if (isOcrType) {
      try {
        console.log(`[OCR] Sending ${file.filename} to OCR service...`);
        const form = new FormData();
        form.append("file", fs.createReadStream(file.path), {
          filename: file.filename,
          contentType: detectedMime,
        });

        const ocrResponse = await fetch(`${OCR_SERVICE_URL}/ocr`, {
          method: "POST",
          body: form,
          headers: form.getHeaders(),
          timeout: 120000,
        });

        if (ocrResponse.ok) {
          const ocrData = await ocrResponse.json();
          result.ocrApplied = true;
          result.extractedText = ocrData.text;

          // Save extracted text
          const textFilename = path.parse(file.filename).name + ".txt";
          const textPath = path.join(textDir, textFilename);
          fs.writeFileSync(textPath, ocrData.text, "utf-8");
          result.textFile = textFilename;

          console.log(`[OCR] Text extracted and saved: ${textFilename}`);
        } else {
          const errText = await ocrResponse.text();
          console.error(`[OCR] Service error: ${errText}`);
          result.ocrError = "OCR service returned an error";
        }
      } catch (ocrErr) {
        console.error(`[OCR] Connection error: ${ocrErr.message}`);
        result.ocrError = `OCR service unavailable: ${ocrErr.message}`;
      }
    }

    res.json({ success: true, file: result });
  } catch (err) {
    console.error("[Upload] Error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ─── List all files ───
app.get("/api/files", (req, res) => {
  try {
    const originals = fs.readdirSync(originalsDir).map((name) => {
      const filePath = path.join(originalsDir, name);
      const stats = fs.statSync(filePath);
      const detectedMime = mime.lookup(name) || "application/octet-stream";
      const baseName = path.parse(name).name;
      const hasText = fs.existsSync(path.join(textDir, baseName + ".txt"));

      return {
        filename: name,
        size: stats.size,
        mimeType: detectedMime,
        isImage: IMAGE_TYPES.includes(detectedMime),
        uploadedAt: stats.mtime.toISOString(),
        hasExtractedText: hasText,
        textFile: hasText ? baseName + ".txt" : null,
      };
    });

    // Sort newest first
    originals.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json({ files: originals });
  } catch (err) {
    console.error("[List] Error:", err);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// ─── Download original file ───
app.get("/api/files/download/:filename", (req, res) => {
  const filePath = path.join(originalsDir, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.download(filePath);
});

// ─── Download extracted text ───
app.get("/api/files/text/:filename", (req, res) => {
  const filePath = path.join(textDir, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Text file not found" });
  }
  res.download(filePath);
});

// ─── Preview/view extracted text ───
app.get("/api/files/text-preview/:filename", (req, res) => {
  const filePath = path.join(textDir, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Text file not found" });
  }
  const text = fs.readFileSync(filePath, "utf-8");
  res.json({ text });
});

// ─── Delete file ───
app.delete("/api/files/:filename", (req, res) => {
  try {
    const origPath = path.join(originalsDir, req.params.filename);
    const baseName = path.parse(req.params.filename).name;
    const txtPath = path.join(textDir, baseName + ".txt");

    if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
    if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// ─── Health check ───
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[API] Document Upload API running on port ${PORT}`);
  console.log(`[API] OCR Service URL: ${OCR_SERVICE_URL}`);
  console.log(`[API] Upload directory: ${UPLOAD_DIR}`);
});
