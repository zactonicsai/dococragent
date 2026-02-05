// ═══════════════════════════════════════════════════════════════════════════════
// DocScan REST API Gateway
// ═══════════════════════════════════════════════════════════════════════════════
// Language-agnostic REST API entry point. Any HTTP client (Java, Go, Python,
// curl, Postman, etc.) authenticates here with an API key and accesses
// versioned endpoints under /v1/*.
//
// Features:
//   • API key authentication (X-API-Key header)
//   • Rate limiting (configurable per window)
//   • Request ID tracking (X-Request-Id)
//   • Structured JSON logging (morgan)
//   • CORS with configurable origins
//   • OpenAPI 3.0 spec served at /v1/openapi.yaml and /v1/docs
//   • Versioned routes: /v1/documents/*, /v1/health
//   • Consistent error envelope: { error: { code, message, requestId } }
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const multer = require("multer");
const fetch = require("node-fetch");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = parseInt(process.env.GATEWAY_PORT) || 4000;
const API_BACKEND = process.env.API_BACKEND_URL || "http://api:3000";
const API_KEY = process.env.API_KEY || "docupload-dev-key-change-me";
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

// ─── Middleware: CORS ───────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-API-Key", "X-Request-Id", "Accept"],
  exposedHeaders: ["X-Request-Id", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
}));

// ─── Middleware: Request ID ─────────────────────────────────────────────────
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || uuidv4();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

// ─── Middleware: JSON body parsing ──────────────────────────────────────────
app.use(express.json());

// ─── Middleware: Request logging ────────────────────────────────────────────
morgan.token("request-id", (req) => req.requestId);
morgan.token("api-key-hint", (req) => {
  const key = req.headers["x-api-key"];
  return key ? `${key.substring(0, 8)}...` : "none";
});
app.use(morgan(
  ':date[iso] :method :url :status :res[content-length] :response-time ms | reqId=:request-id key=:api-key-hint',
  { stream: process.stdout }
));

// ─── Middleware: Rate Limiting ──────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,   // Return rate limit info in RateLimit-* headers
  legacyHeaders: true,     // Also X-RateLimit-* headers
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: `Too many requests. Limit: ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW / 1000}s window.`,
    }
  },
  keyGenerator: (req) => req.headers["x-api-key"] || req.ip,
});
app.use("/v1/", limiter);

// ─── Middleware: API Key Authentication ─────────────────────────────────────
function authenticateApiKey(req, res, next) {
  // Skip auth for docs and health
  if (req.path === "/v1/openapi.yaml" || req.path === "/v1/docs" || req.path === "/v1/health") {
    return next();
  }

  const key = req.headers["x-api-key"];
  if (!key) {
    return res.status(401).json({
      error: {
        code: "MISSING_API_KEY",
        message: "X-API-Key header is required. See /v1/docs for API documentation.",
        requestId: req.requestId,
      }
    });
  }
  if (key !== API_KEY) {
    return res.status(403).json({
      error: {
        code: "INVALID_API_KEY",
        message: "The provided API key is not valid.",
        requestId: req.requestId,
      }
    });
  }
  next();
}
app.use("/v1/", authenticateApiKey);

// ─── Multer for multipart uploads ──────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─── Helper: Error envelope ────────────────────────────────────────────────
function errorResponse(res, status, code, message, requestId) {
  return res.status(status).json({
    error: { code, message, requestId }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERSIONED API ROUTES: /v1/*
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /v1/health ─────────────────────────────────────────────────────────
// Health check — no auth required
app.get("/v1/health", async (req, res) => {
  try {
    const backendRes = await fetch(`${API_BACKEND}/api/health`, { timeout: 5000 });
    const backendData = await backendRes.json();
    res.json({
      status: "ok",
      gateway: { version: "1.0.0", timestamp: new Date().toISOString() },
      backend: backendData,
      requestId: req.requestId,
    });
  } catch (err) {
    res.json({
      status: "degraded",
      gateway: { version: "1.0.0", timestamp: new Date().toISOString() },
      backend: { status: "unreachable", error: err.message },
      requestId: req.requestId,
    });
  }
});

// ─── POST /v1/documents ─────────────────────────────────────────────────────
// Upload a document. Accepts multipart/form-data with field "document".
// Returns document metadata, type detection, and OCR results.
app.post("/v1/documents", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, "NO_FILE", "Request must include a 'document' field with a file.", req.requestId);
    }

    // Forward the file to the internal API
    const form = new FormData();
    form.append("document", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const backendRes = await fetch(`${API_BACKEND}/api/upload`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
      timeout: 120000,
    });

    const data = await backendRes.json();

    if (!backendRes.ok) {
      return errorResponse(res, backendRes.status, "UPLOAD_FAILED", data.error || "Upload failed.", req.requestId);
    }

    // Transform to clean REST response
    const doc = data.file;
    const response = {
      document: {
        id: doc.filename,
        originalName: doc.originalName,
        mimeType: doc.mimeType,
        sizeBytes: doc.size,
        classification: {
          isImage: doc.isImage,
          isPdf: doc.isPdf,
          category: doc.isImage ? "image" : doc.isPdf ? "pdf" : "document",
        },
        ocr: {
          applied: doc.ocrApplied,
          extractedText: doc.extractedText,
          textFileId: doc.textFile || null,
          characterCount: doc.extractedText ? doc.extractedText.length : 0,
          error: doc.ocrError || null,
        },
        links: {
          downloadOriginal: `/v1/documents/${encodeURIComponent(doc.filename)}/download`,
          downloadText: doc.textFile ? `/v1/documents/${encodeURIComponent(doc.filename)}/text` : null,
          delete: `/v1/documents/${encodeURIComponent(doc.filename)}`,
        }
      },
      requestId: req.requestId,
    };

    res.status(201).json(response);
  } catch (err) {
    console.error(`[Gateway] Upload error: ${err.message}`);
    errorResponse(res, 500, "INTERNAL_ERROR", "An unexpected error occurred.", req.requestId);
  }
});

// ─── GET /v1/documents ──────────────────────────────────────────────────────
// List all uploaded documents with metadata.
app.get("/v1/documents", async (req, res) => {
  try {
    const backendRes = await fetch(`${API_BACKEND}/api/files`, { timeout: 10000 });
    const data = await backendRes.json();

    const documents = (data.files || []).map((f) => ({
      id: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.size,
      isImage: f.isImage,
      uploadedAt: f.uploadedAt,
      ocr: {
        hasExtractedText: f.hasExtractedText,
        textFileId: f.textFile,
      },
      links: {
        downloadOriginal: `/v1/documents/${encodeURIComponent(f.filename)}/download`,
        downloadText: f.textFile ? `/v1/documents/${encodeURIComponent(f.filename)}/text` : null,
        delete: `/v1/documents/${encodeURIComponent(f.filename)}`,
      }
    }));

    res.json({
      documents,
      count: documents.length,
      requestId: req.requestId,
    });
  } catch (err) {
    errorResponse(res, 500, "INTERNAL_ERROR", "Failed to list documents.", req.requestId);
  }
});

// ─── GET /v1/documents/:id/download ─────────────────────────────────────────
// Download original file.
app.get("/v1/documents/:id/download", async (req, res) => {
  try {
    const backendRes = await fetch(
      `${API_BACKEND}/api/files/download/${encodeURIComponent(req.params.id)}`,
      { timeout: 30000 }
    );
    if (!backendRes.ok) {
      return errorResponse(res, 404, "NOT_FOUND", "Document not found.", req.requestId);
    }
    // Stream the file to client
    res.setHeader("Content-Type", backendRes.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", backendRes.headers.get("content-disposition") || "attachment");
    backendRes.body.pipe(res);
  } catch (err) {
    errorResponse(res, 500, "INTERNAL_ERROR", "Download failed.", req.requestId);
  }
});

// ─── GET /v1/documents/:id/text ─────────────────────────────────────────────
// Download extracted text file.
app.get("/v1/documents/:id/text", async (req, res) => {
  try {
    // Derive text filename from document ID
    const baseName = path.parse(req.params.id).name;
    const textFile = baseName + ".txt";

    const backendRes = await fetch(
      `${API_BACKEND}/api/files/text/${encodeURIComponent(textFile)}`,
      { timeout: 10000 }
    );
    if (!backendRes.ok) {
      return errorResponse(res, 404, "NOT_FOUND", "No extracted text found for this document.", req.requestId);
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${textFile}"`);
    backendRes.body.pipe(res);
  } catch (err) {
    errorResponse(res, 500, "INTERNAL_ERROR", "Text download failed.", req.requestId);
  }
});

// ─── GET /v1/documents/:id/text/preview ─────────────────────────────────────
// Get extracted text as JSON (for programmatic access).
app.get("/v1/documents/:id/text/preview", async (req, res) => {
  try {
    const baseName = path.parse(req.params.id).name;
    const textFile = baseName + ".txt";

    const backendRes = await fetch(
      `${API_BACKEND}/api/files/text-preview/${encodeURIComponent(textFile)}`,
      { timeout: 10000 }
    );
    if (!backendRes.ok) {
      return errorResponse(res, 404, "NOT_FOUND", "No extracted text found for this document.", req.requestId);
    }
    const data = await backendRes.json();
    res.json({
      documentId: req.params.id,
      text: data.text,
      characterCount: data.text ? data.text.length : 0,
      requestId: req.requestId,
    });
  } catch (err) {
    errorResponse(res, 500, "INTERNAL_ERROR", "Text preview failed.", req.requestId);
  }
});

// ─── DELETE /v1/documents/:id ───────────────────────────────────────────────
// Delete a document and its extracted text.
app.delete("/v1/documents/:id", async (req, res) => {
  try {
    const backendRes = await fetch(
      `${API_BACKEND}/api/files/${encodeURIComponent(req.params.id)}`,
      { method: "DELETE", timeout: 10000 }
    );
    if (!backendRes.ok) {
      return errorResponse(res, 404, "NOT_FOUND", "Document not found.", req.requestId);
    }
    res.json({
      deleted: true,
      documentId: req.params.id,
      requestId: req.requestId,
    });
  } catch (err) {
    errorResponse(res, 500, "INTERNAL_ERROR", "Delete failed.", req.requestId);
  }
});

// ─── GET /v1/openapi.yaml ───────────────────────────────────────────────────
// Serve the OpenAPI specification.
app.get("/v1/openapi.yaml", (req, res) => {
  const specPath = path.join(__dirname, "openapi.yaml");
  if (fs.existsSync(specPath)) {
    res.setHeader("Content-Type", "text/yaml");
    res.sendFile(specPath);
  } else {
    errorResponse(res, 404, "NOT_FOUND", "OpenAPI spec not found.", req.requestId);
  }
});

// ─── GET /v1/docs ───────────────────────────────────────────────────────────
// Redirect to OpenAPI spec (or serve Swagger UI in production).
app.get("/v1/docs", (req, res) => {
  res.redirect("/v1/openapi.yaml");
});

// ─── Root redirect ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    service: "DocScan REST API Gateway",
    version: "1.0.0",
    docs: "/v1/docs",
    health: "/v1/health",
    endpoints: {
      "POST /v1/documents":              "Upload a document (multipart/form-data)",
      "GET  /v1/documents":              "List all documents",
      "GET  /v1/documents/:id/download": "Download original file",
      "GET  /v1/documents/:id/text":     "Download extracted text",
      "GET  /v1/documents/:id/text/preview": "Get extracted text as JSON",
      "DELETE /v1/documents/:id":        "Delete a document",
    },
    authentication: "Pass X-API-Key header with every request",
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════`);
  console.log(`  DocScan REST API Gateway`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Backend:  ${API_BACKEND}`);
  console.log(`  Auth:     API Key (X-API-Key header)`);
  console.log(`  Rate:     ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW / 1000}s`);
  console.log(`  Docs:     http://localhost:${PORT}/v1/docs`);
  console.log(`═══════════════════════════════════════════════════`);
});
