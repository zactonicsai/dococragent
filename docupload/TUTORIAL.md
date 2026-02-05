# DocScan — Complete System Design Tutorial & Architecture Guide

> **A comprehensive, line-by-line walkthrough of a Docker Compose application for document upload, type detection, OCR text extraction, and file management.**

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Technology Stack](#3-technology-stack)
4. [Project Directory Structure](#4-project-directory-structure)
5. [Docker Compose — Line-by-Line](#5-docker-compose--line-by-line)
6. [Service 1: OCR Service (Python/Flask/Tesseract)](#6-service-1-ocr-service)
7. [Service 2: API Server (Node.js/Express)](#7-service-2-api-server)
8. [Service 3: Frontend App (Nginx/HTML/Tailwind)](#8-service-3-frontend-app)
9. [Nginx Reverse Proxy Configuration](#9-nginx-reverse-proxy-configuration)
10. [Upload Page — Line-by-Line](#10-upload-page--line-by-line)
11. [File Browser Page — Line-by-Line](#11-file-browser-page--line-by-line)
12. [OCR Deep Dive — How Tesseract Works](#12-ocr-deep-dive)
13. [Dependency Reference](#13-dependency-reference)
14. [Data Flow Walkthrough](#14-data-flow-walkthrough)
15. [Docker Networking Explained](#15-docker-networking-explained)
16. [Volume & Storage Architecture](#16-volume--storage-architecture)
17. [Security Considerations](#17-security-considerations)
18. [Troubleshooting Guide](#18-troubleshooting-guide)
19. [Extending the System](#19-extending-the-system)
20. [Quick Start](#20-quick-start)

---

## 1. System Overview

DocScan is a **microservices-based document management system** built with Docker Compose. It solves a common problem: uploading documents, automatically extracting text from images and PDFs using OCR (Optical Character Recognition), and providing a browsable file manager to download both originals and extracted text.

### What It Does

1. **Accepts any file upload** via a drag-and-drop web interface
2. **Detects the file type** by inspecting the MIME type
3. **Routes images and PDFs** to a dedicated OCR microservice
4. **Extracts text** using Tesseract OCR engine
5. **Stores both** the original file and extracted `.txt` file
6. **Provides a file browser** to view, preview, download, and delete files

### Design Principles

- **Separation of Concerns** — Each service has one job (serve UI, handle API logic, perform OCR)
- **Loose Coupling** — Services communicate over HTTP REST; swapping the OCR engine requires zero changes to the API or frontend
- **Container Isolation** — Each service runs in its own container with its own dependencies
- **Shared Storage** — A Docker volume provides persistent file storage across container restarts

---

## 2. Architecture Diagram

```
                    ┌─────────────────────────────────────────────────────┐
                    │                  Docker Network: docnet             │
                    │                                                     │
 User Browser       │  ┌─────────────┐   ┌──────────────┐   ┌─────────┐ │
 ─────────────►     │  │    app       │   │     api      │   │   ocr   │ │
 http://localhost:  │  │   (Nginx)    │──►│  (Express)   │──►│ (Flask) │ │
       8080         │  │  Port 80     │   │  Port 3000   │   │Port 5000│ │
                    │  │              │   │              │   │         │ │
                    │  │ Static HTML  │   │ Upload Logic │   │Tesseract│ │
                    │  │ Tailwind CSS │   │ Type Detect  │   │ OCR     │ │
                    │  │ JavaScript   │   │ File Storage │   │Poppler  │ │
                    │  └─────────────┘   └──────┬───────┘   └─────────┘ │
                    │                           │                        │
                    │                    ┌──────▼───────┐                │
                    │                    │ Docker Volume │                │
                    │                    │   "uploads"   │                │
                    │                    │               │                │
                    │                    │ ├─originals/  │                │
                    │                    │ │ ├─img.png   │                │
                    │                    │ │ └─doc.pdf   │                │
                    │                    │ └─text/       │                │
                    │                    │   ├─img.txt   │                │
                    │                    │   └─doc.txt   │                │
                    │                    └───────────────┘                │
                    └─────────────────────────────────────────────────────┘
```

### Request Flow

```
User drops file ──► Nginx (port 8080)
                       │
                       ├── Static files (HTML/CSS/JS) ──► served directly
                       │
                       └── /api/* requests ──► proxy_pass to api:3000
                                                    │
                                                    ├── Save original to /uploads/originals/
                                                    │
                                                    ├── Is it an image or PDF?
                                                    │     YES ──► POST to ocr:5000/ocr
                                                    │               │
                                                    │               └── Tesseract extracts text
                                                    │                     │
                                                    │               ◄─────┘ Returns JSON {text: "..."}
                                                    │
                                                    ├── Save extracted text to /uploads/text/
                                                    │
                                                    └── Return JSON response to browser
```

---

## 3. Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Container Orchestration** | Docker Compose | 3.8 | Define and run multi-container app |
| **Frontend Web Server** | Nginx | Alpine | Serve static files, reverse proxy API |
| **Frontend UI** | HTML5 + Tailwind CSS | CDN | Responsive, modern UI without build step |
| **Frontend Logic** | Vanilla JavaScript | ES6+ | File upload, drag-drop, AJAX calls |
| **API Runtime** | Node.js | 18 (Alpine) | Server-side JavaScript runtime |
| **API Framework** | Express.js | 4.18 | HTTP routing, middleware, request handling |
| **File Upload Handling** | Multer | 1.4.5 | Multipart form-data parsing |
| **OCR Runtime** | Python | 3.11 (Slim) | OCR service runtime |
| **OCR Web Framework** | Flask | 3.0 | Lightweight HTTP server for OCR |
| **OCR Production Server** | Gunicorn | 21.2 | WSGI HTTP server (multi-worker) |
| **OCR Engine** | Tesseract | 5.x | Open-source OCR engine by Google |
| **PDF Processing** | Poppler (pdftoppm) | System | Convert PDF pages to images for OCR |
| **MIME Detection** | mime-types (npm) | 2.1.35 | Determine file type from extension |
| **HTTP Client** | node-fetch | 2.7 | API-to-OCR service communication |
| **Form Data** | form-data (npm) | 4.0 | Construct multipart requests to OCR |
| **CORS** | cors (npm) | 2.8.5 | Cross-origin resource sharing |

---

## 4. Project Directory Structure

```
docupload/
│
├── docker-compose.yml          # Orchestration: defines all 3 services
│
├── app/                        # SERVICE 1: Frontend (Nginx + HTML)
│   ├── Dockerfile              # Nginx Alpine image + copy static files
│   ├── nginx.conf              # Reverse proxy config: /api/* → api:3000
│   ├── index.html              # Upload page (drag-drop, progress, results)
│   └── files.html              # File browser (list, preview, download, delete)
│
├── api/                        # SERVICE 2: Backend API (Node.js/Express)
│   ├── Dockerfile              # Node 18 Alpine + npm install
│   ├── package.json            # Dependencies: express, multer, cors, etc.
│   └── server.js               # All API endpoints + OCR routing logic
│
├── ocr-service/                # SERVICE 3: OCR Engine (Python/Flask/Tesseract)
│   ├── Dockerfile              # Python 3.11 + Tesseract + Poppler install
│   ├── requirements.txt        # Flask + Gunicorn
│   └── app.py                  # OCR processing: image + PDF support
│
├── uploads/                    # Local mount point (Docker volume in production)
│   ├── originals/              # Original uploaded files
│   └── text/                   # Extracted text files (.txt)
│
└── README.md                   # Quick-start documentation
```

---

## 5. Docker Compose — Line-by-Line

```yaml
version: "3.8"
```
**Line 1:** Specifies the Docker Compose file format version. Version `3.8` supports all modern features including named volumes, networks, health checks, and deploy configurations. It requires Docker Engine 19.03.0+.

---

```yaml
services:
```
**Line 3:** The `services` key defines each container that Docker Compose will build and run. Each child key becomes a service name used for inter-container DNS resolution.

---

### The `app` Service (Frontend)

```yaml
  app:
    build: ./app
    container_name: docupload-app
    ports:
      - "8080:80"
    depends_on:
      - api
    networks:
      - docnet
```

| Line | Directive | Explanation |
|------|-----------|-------------|
| `build: ./app` | **Build context** — Docker looks for a `Dockerfile` inside `./app/` and builds the image from that directory. All `COPY` commands in the Dockerfile are relative to `./app/`. |
| `container_name: docupload-app` | **Explicit name** — Without this, Docker Compose would name it `docupload-app-1`. Setting an explicit name makes `docker logs docupload-app` easier. |
| `ports: "8080:80"` | **Port mapping** — Maps host port `8080` to container port `80` (Nginx default). Users access the app at `http://localhost:8080`. The format is `HOST:CONTAINER`. |
| `depends_on: api` | **Startup order** — Docker Compose starts the `api` service before `app`. Note: this only waits for the container to *start*, not for the application inside to be *ready*. For production, use health checks. |
| `networks: docnet` | **Network attachment** — Connects this container to the `docnet` bridge network so it can resolve `api` as a hostname. |

---

### The `api` Service (Backend)

```yaml
  api:
    build: ./api
    container_name: docupload-api
    ports:
      - "3000:3000"
    volumes:
      - uploads:/app/uploads
    environment:
      - OCR_SERVICE_URL=http://ocr:5000
      - UPLOAD_DIR=/app/uploads
    depends_on:
      - ocr
    networks:
      - docnet
```

| Line | Directive | Explanation |
|------|-----------|-------------|
| `build: ./api` | Builds from `./api/Dockerfile`. The build context includes `package.json` and `server.js`. |
| `ports: "3000:3000"` | Exposes the Express server. While Nginx proxies `/api/*` traffic internally, exposing port 3000 allows direct API access for debugging. |
| `volumes: uploads:/app/uploads` | **Named volume mount** — Mounts the Docker-managed `uploads` volume to `/app/uploads` inside the container. Data persists across container restarts and rebuilds. |
| `environment: OCR_SERVICE_URL` | **Service discovery** — The API needs to know where the OCR service lives. On the `docnet` network, `ocr` resolves to the OCR container's IP. The full URL `http://ocr:5000` is used by `node-fetch` to POST files for OCR processing. |
| `environment: UPLOAD_DIR` | **Configurable storage path** — Rather than hardcoding `/app/uploads`, the code reads `process.env.UPLOAD_DIR`. This makes the service portable. |
| `depends_on: ocr` | Ensures the OCR container starts first (but not necessarily *ready* — the API handles OCR connection errors gracefully). |

---

### The `ocr` Service

```yaml
  ocr:
    build: ./ocr-service
    container_name: docupload-ocr
    ports:
      - "5000:5000"
    networks:
      - docnet
```

| Line | Directive | Explanation |
|------|-----------|-------------|
| `build: ./ocr-service` | Builds from `./ocr-service/Dockerfile`, which installs Python, Tesseract, and Poppler. This is the heaviest image (~300MB) due to OCR dependencies. |
| `ports: "5000:5000"` | Exposes Flask/Gunicorn. Primarily for health check access from the host (`curl localhost:5000/health`). Internal traffic uses `ocr:5000` on `docnet`. |

---

### Volumes & Networks

```yaml
volumes:
  uploads:
    driver: local

networks:
  docnet:
    driver: bridge
```

| Block | Explanation |
|-------|-------------|
| `volumes: uploads` | **Named volume** — Docker creates a managed volume on the host filesystem (typically at `/var/lib/docker/volumes/docupload_uploads/_data`). Unlike bind mounts, named volumes are portable, performant, and survive `docker compose down`. Only `docker compose down -v` removes them. |
| `driver: local` | Uses the default local filesystem driver. Other drivers (e.g., `nfs`, `aws-ebs`) support remote storage. |
| `networks: docnet` | **User-defined bridge network** — Creates an isolated network. Containers on this network can resolve each other by service name (e.g., `api` can reach `http://ocr:5000`). Unlike the default bridge, user-defined bridges provide automatic DNS resolution. |
| `driver: bridge` | Standard Linux bridge networking. Each container gets its own IP in a private subnet (e.g., `172.18.0.0/16`). |

---

## 6. Service 1: OCR Service

### 6.1 Dockerfile — Line-by-Line

```dockerfile
FROM python:3.11-slim
```
**Base image:** Python 3.11 on Debian "slim" variant. The slim image excludes development tools, man pages, and documentation — reducing image size from ~900MB to ~150MB while keeping the full Python runtime.

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
```

| Package | What It Is | Why It's Needed |
|---------|-----------|-----------------|
| `tesseract-ocr` | Google's open-source OCR engine (v5.x) | Core OCR functionality — converts images to text |
| `tesseract-ocr-eng` | English language training data | Tesseract needs language-specific models (`.traineddata` files) to recognize characters. Without this, OCR produces garbage. |
| `poppler-utils` | PDF rendering library (includes `pdftoppm`) | Tesseract cannot read PDFs directly. Poppler converts PDF pages into PNG images at 300 DPI, which Tesseract then processes. |
| `libglib2.0-0` | GLib C utility library | Runtime dependency for Poppler's rendering pipeline. Without it, `pdftoppm` crashes with missing library errors. |
| `rm -rf /var/lib/apt/lists/*` | Cleanup | Removes the apt package cache, saving ~30MB in the final image. |
| `--no-install-recommends` | Minimal install | Prevents apt from installing "recommended" but unnecessary packages. |

```dockerfile
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
```

**Build optimization:** By copying `requirements.txt` *before* `app.py`, Docker caches the `pip install` layer. Changes to `app.py` don't trigger a reinstall of dependencies — saving minutes on rebuilds.

```dockerfile
EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "120", "--workers", "2", "app:app"]
```

| Flag | Purpose |
|------|---------|
| `--bind 0.0.0.0:5000` | Listen on all interfaces inside the container (required for Docker networking) |
| `--timeout 120` | Allow 120 seconds per request before killing the worker. OCR on large images or multi-page PDFs can take 30-60 seconds. The default 30s would cause premature timeouts. |
| `--workers 2` | Spawn 2 Gunicorn worker processes. Each can handle one OCR request concurrently. More workers = more parallelism but more RAM (each Tesseract process uses ~100-200MB). |
| `app:app` | Module:variable — import the `app` variable from `app.py` |

---

### 6.2 requirements.txt

```
flask==3.0.0
gunicorn==21.2.0
```

| Package | Purpose |
|---------|---------|
| **Flask 3.0** | Micro web framework. Handles HTTP routing, request parsing, file uploads, and JSON responses. Chosen over Django/FastAPI for simplicity — the OCR service has only 2 endpoints. |
| **Gunicorn 21.2** | Production WSGI server. Flask's built-in server is single-threaded and not suitable for production. Gunicorn pre-forks worker processes, handles graceful restarts, and manages worker lifecycle. |

---

### 6.3 app.py — Line-by-Line

#### Imports and Setup

```python
import os
import tempfile
import subprocess
from flask import Flask, request, jsonify

app = Flask(__name__)
```

| Import | Why |
|--------|-----|
| `os` | File path operations, environment variables, file deletion |
| `tempfile` | Create secure temporary files and directories. Uploaded files are written to temp storage, processed, then deleted — preventing disk bloat. |
| `subprocess` | Execute Tesseract and pdftoppm as external processes. Python calls the CLI tools rather than using Python bindings, which simplifies dependencies and error handling. |
| `Flask` | The web framework |
| `request` | Access to the incoming HTTP request (files, headers, form data) |
| `jsonify` | Convert Python dicts to JSON responses with correct `Content-Type: application/json` headers |

#### Allowed File Types

```python
ALLOWED_EXTENSIONS = {
    'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp', 'pdf'
}
```

This set defines which file extensions the OCR service will process. Each format has different characteristics:

| Format | Tesseract Support | Notes |
|--------|-------------------|-------|
| **PNG** | Native, excellent | Lossless compression, ideal for OCR |
| **JPEG/JPG** | Native, good | Lossy compression can reduce accuracy on low-quality images |
| **TIFF/TIF** | Native, excellent | Industry standard for scanned documents, supports multi-page |
| **BMP** | Native, good | Uncompressed bitmap, large file sizes |
| **GIF** | Native, limited | 256-color limit reduces quality; not ideal for OCR |
| **WebP** | Native (Tesseract 5+) | Modern format with good compression |
| **PDF** | Indirect (via Poppler) | Converted to PNG images first, then each page is OCR'd |

#### The OCR Image Function

```python
def ocr_image(filepath):
    """Run Tesseract OCR on an image file."""
    try:
        result = subprocess.run(
            ['tesseract', filepath, 'stdout', '--oem', '3', '--psm', '3'],
            capture_output=True, text=True, timeout=120
        )
```

**Tesseract command breakdown:**

| Argument | Meaning |
|----------|---------|
| `tesseract` | The Tesseract executable |
| `filepath` | Input image path |
| `stdout` | Output destination — `stdout` means write to standard output instead of a file. This lets us capture the text directly in Python. |
| `--oem 3` | **OCR Engine Mode 3** (Default, based on what is available). See OEM modes below. |
| `--psm 3` | **Page Segmentation Mode 3** (Fully automatic page segmentation, no OSD). See PSM modes below. |
| `capture_output=True` | Captures both stdout (the text) and stderr (warnings/errors) |
| `text=True` | Decode output as UTF-8 strings instead of raw bytes |
| `timeout=120` | Kill the process if it runs longer than 120 seconds |

**Tesseract OCR Engine Modes (OEM):**

| Mode | Name | Description |
|------|------|-------------|
| 0 | Legacy | Original Tesseract engine (pattern matching). Faster but less accurate. |
| 1 | LSTM | Neural network engine only. Most accurate for modern documents. |
| 2 | Legacy + LSTM | Runs both and combines results. |
| 3 | Default | Uses whatever is available (typically LSTM in Tesseract 5). **We use this.** |

**Tesseract Page Segmentation Modes (PSM):**

| Mode | Name | Best For |
|------|------|----------|
| 0 | OSD only | Detecting orientation and script |
| 1 | Auto + OSD | Automatic with orientation detection |
| 3 | **Fully automatic** | **General documents (our default)** |
| 4 | Single column | Books, single-column text |
| 6 | Single block | Uniform blocks of text |
| 7 | Single line | One line of text (e.g., license plates) |
| 8 | Single word | One word |
| 10 | Single character | One character |
| 11 | Sparse text | Text scattered across the image |
| 13 | Raw line | Treat image as single text line (no Tesseract hacks) |

#### The PDF OCR Function

```python
def ocr_pdf(filepath):
    """Convert PDF pages to images, then OCR each page."""
    text_parts = []
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            subprocess.run(
                ['pdftoppm', '-png', '-r', '300', filepath,
                 os.path.join(tmpdir, 'page')],
                capture_output=True, timeout=120, check=True
            )
```

**Why can't Tesseract read PDFs directly?**
Tesseract is an *image* OCR engine. PDFs are container documents that can hold vector graphics, fonts, and metadata — not raw pixel data. We must first "rasterize" (render to pixels) each PDF page.

**pdftoppm command breakdown:**

| Argument | Meaning |
|----------|---------|
| `pdftoppm` | Poppler's PDF-to-image converter |
| `-png` | Output format. PNG is lossless, preserving text clarity for OCR. |
| `-r 300` | **Resolution: 300 DPI.** This is critical. At 72 DPI (screen resolution), small text becomes unreadable to OCR. At 300 DPI, a standard 8.5x11" page becomes a 2550x3300 pixel image — enough detail for Tesseract to recognize individual characters. 600 DPI is more accurate but 4x the processing time and memory. |
| `filepath` | Input PDF path |
| `page` | Output prefix — creates `page-01.png`, `page-02.png`, etc. |

**The page-by-page OCR loop:**

```python
        page_images = sorted([
            f for f in os.listdir(tmpdir) if f.endswith('.png')
        ])

        for i, img_name in enumerate(page_images, 1):
            img_path = os.path.join(tmpdir, img_name)
            page_text = ocr_image(img_path)
            text_parts.append(f"--- Page {i} ---\n{page_text}")

    return "\n\n".join(text_parts)
```

Each page is OCR'd independently, labeled with a page separator (`--- Page 1 ---`), and combined into a single text output. The temporary directory is automatically cleaned up by `with tempfile.TemporaryDirectory()`.

#### The `/ocr` Endpoint

```python
@app.route('/ocr', methods=['POST'])
def process_ocr():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
```

Flask's `request.files` is a dictionary-like object containing uploaded files from a `multipart/form-data` request. The key `'file'` must match the form field name used by the API server when forwarding the file.

```python
    ext = file.filename.rsplit('.', 1)[1].lower()
    with tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name
```

**Why `delete=False`?** Normally, `NamedTemporaryFile` deletes itself when closed. But Tesseract needs to open the file by path *after* we close it, so we keep it alive and manually delete in the `finally` block.

**Why preserve the extension?** Tesseract uses the file extension to determine the input format. A `.png` file named `.tmp` would confuse the format auto-detection.

```python
    try:
        if ext == 'pdf':
            text = ocr_pdf(tmp_path)
        else:
            text = ocr_image(tmp_path)

        return jsonify({
            'text': text,
            'filename': file.filename,
            'characters': len(text),
            'success': True
        })
    finally:
        os.unlink(tmp_path)
```

The response includes the extracted text, original filename, character count (useful for empty-page detection), and a success flag. The `finally` block ensures the temp file is always deleted, even if an exception occurs.

---

## 7. Service 2: API Server

### 7.1 Dockerfile — Line-by-Line

```dockerfile
FROM node:18-alpine
```
**Node.js 18 on Alpine Linux.** Alpine uses musl libc instead of glibc, producing images ~5x smaller than Debian-based Node images (~50MB vs ~300MB). Node 18 is an LTS (Long Term Support) release.

```dockerfile
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
RUN mkdir -p /app/uploads/originals /app/uploads/text
```

| Line | Purpose |
|------|---------|
| `COPY package.json` then `RUN npm install` | **Layer caching optimization.** Docker caches each layer. By copying `package.json` first, the `npm install` layer is cached as long as dependencies don't change. Only changes to `server.js` trigger a rebuild of the final layer. |
| `--production` | Skips `devDependencies`, reducing image size and attack surface |
| `mkdir -p` | Creates the upload directories. These are overridden when the Docker volume is mounted, but they serve as fallbacks for local development. |

### 7.2 package.json — Dependencies Explained

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "cors": "^2.8.5",
    "mime-types": "^2.1.35",
    "node-fetch": "^2.7.0",
    "form-data": "^4.0.0"
  }
}
```

| Package | What It Does | Why Version 2.x for node-fetch? |
|---------|-------------|--------------------------------|
| **express** | HTTP framework — routing, middleware, request/response handling | — |
| **multer** | Middleware for `multipart/form-data` — handles file uploads, writes to disk, enforces size limits | — |
| **cors** | Adds `Access-Control-Allow-Origin` headers — required when frontend and API are on different ports during development | — |
| **mime-types** | Maps file extensions to MIME types (e.g., `.png` → `image/png`) using the Apache MIME database | — |
| **node-fetch** | HTTP client for making requests from Node.js to the OCR service | v3.x is ESM-only and requires `import` syntax. v2.x works with `require()` / CommonJS, which our `server.js` uses. |
| **form-data** | Constructs `multipart/form-data` payloads for forwarding files to the OCR service | — |

### 7.3 server.js — Line-by-Line

#### Initialization

```javascript
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
```

`process.env.UPLOAD_DIR` reads from the Docker Compose `environment` block. The `|| "./uploads"` fallback enables local development without Docker.

#### Directory Setup

```javascript
const originalsDir = path.join(UPLOAD_DIR, "originals");
const textDir = path.join(UPLOAD_DIR, "text");
fs.mkdirSync(originalsDir, { recursive: true });
fs.mkdirSync(textDir, { recursive: true });
```

`{ recursive: true }` is equivalent to `mkdir -p` — it creates the directory and all parent directories, and does *not* throw an error if they already exist.

#### Multer Storage Configuration

```javascript
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
  limits: { fileSize: 50 * 1024 * 1024 },
});
```

| Config | Purpose |
|--------|---------|
| `diskStorage` | Tells Multer to write files directly to disk (vs. `memoryStorage` which buffers in RAM — dangerous for large files) |
| `destination` | Where to save — the `originals/` directory |
| `filename` | Generates unique filenames: `1706900000000-my_document.pdf`. The timestamp prefix prevents collisions. The regex strips unsafe characters (path traversal, unicode issues). |
| `fileSize: 50 * 1024 * 1024` | 50 MB limit. Multer rejects larger files with a 413 error before they're fully received, saving bandwidth and disk. |

#### Image Type Detection

```javascript
const IMAGE_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/tiff",
  "image/bmp", "image/gif", "image/webp",
];

const OCR_TYPES = [...IMAGE_TYPES, "application/pdf"];
```

`OCR_TYPES` combines all image MIME types plus PDF. The spread operator (`...`) copies the image array and appends PDF. This is used to decide whether to route a file to the OCR service.

#### Upload Endpoint

```javascript
app.post("/api/upload", upload.single("document"), async (req, res) => {
```

| Part | Meaning |
|------|---------|
| `upload.single("document")` | Multer middleware: expects ONE file in a form field named `"document"`. This must match the frontend's `formData.append('document', file)`. |
| `async` | The handler is async because it `await`s the OCR HTTP call |

**File type detection:**

```javascript
    const detectedMime = mime.lookup(file.originalname) || file.mimetype;
    const isOcrType = OCR_TYPES.includes(detectedMime);
```

`mime.lookup("photo.png")` returns `"image/png"` based on the extension. It's more reliable than `file.mimetype`, which comes from the browser and can be incorrect. The fallback `|| file.mimetype` handles unknown extensions.

**OCR routing:**

```javascript
    if (isOcrType) {
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
```

| Technique | Why |
|-----------|-----|
| `fs.createReadStream` | Streams the file to the OCR service instead of loading it entirely into memory. For a 50MB image, this saves 50MB of RAM. |
| `form.getHeaders()` | Returns the `Content-Type: multipart/form-data; boundary=...` header. The boundary is a random string that separates parts in the multipart payload. |
| `timeout: 120000` | 120-second timeout matches Gunicorn's worker timeout. |

**Text storage:**

```javascript
      const textFilename = path.parse(file.filename).name + ".txt";
      const textPath = path.join(textDir, textFilename);
      fs.writeFileSync(textPath, ocrData.text, "utf-8");
```

`path.parse("1706900000000-photo.png").name` returns `"1706900000000-photo"`. Adding `.txt` creates a parallel file in the `text/` directory, maintaining a clear mapping between originals and their extracted text.

#### File Listing Endpoint

```javascript
app.get("/api/files", (req, res) => {
  const originals = fs.readdirSync(originalsDir).map((name) => {
    const stats = fs.statSync(filePath);
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

  originals.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
```

For each file in the `originals/` directory, the API reads filesystem metadata (`stat`), detects the MIME type, and checks whether a corresponding `.txt` file exists. Results are sorted newest-first.

#### Download Endpoints

```javascript
app.get("/api/files/download/:filename", (req, res) => {
  res.download(filePath);
});
```

Express's `res.download()` sets the `Content-Disposition: attachment` header, triggering a browser download dialog. It also streams the file efficiently without loading it into memory.

#### Delete Endpoint

```javascript
app.delete("/api/files/:filename", (req, res) => {
  if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
  if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
});
```

Deletes both the original file and its extracted text file (if it exists). `unlinkSync` removes the filesystem entry. In production, consider soft-deletes or a trash mechanism.

---

## 8. Service 3: Frontend App

### 8.1 Dockerfile

```dockerfile
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY files.html /usr/share/nginx/html/files.html

EXPOSE 80
```

This is the simplest Dockerfile — no build step, no dependencies. We copy static files into Nginx's default serving directory and replace the default site config with our reverse proxy configuration.

**Why Nginx instead of serving from Express?** Separation of concerns. Nginx excels at serving static files (zero-copy sendfile, gzip, caching headers) and reverse proxying. Express excels at business logic. Combining them makes each service easier to scale, debug, and update independently.

---

## 9. Nginx Reverse Proxy Configuration

```nginx
server {
    listen 80;
    server_name localhost;
    client_max_body_size 50M;
```

| Directive | Purpose |
|-----------|---------|
| `listen 80` | HTTP default port inside the container |
| `client_max_body_size 50M` | **Critical:** Nginx defaults to 1MB request bodies. Without this, file uploads over 1MB return `413 Request Entity Too Large` *before reaching Express*. This must match or exceed Multer's 50MB limit. |

```nginx
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

| Block | Behavior |
|-------|----------|
| `location /api/` | Any request starting with `/api/` is forwarded to the API container. `http://api:3000` uses Docker's internal DNS — `api` resolves to the API container's IP on the `docnet` network. |
| `proxy_set_header Host` | Preserves the original `Host` header so Express knows the client-facing hostname |
| `proxy_set_header X-Real-IP` | Passes the client's real IP. Without this, Express sees Nginx's container IP for all requests. |
| `proxy_read_timeout 120s` | Waits up to 120s for the API to respond. OCR processing can be slow. The default 60s would kill long-running OCR requests. |
| `try_files $uri $uri/ /index.html` | For non-API requests: try the exact file, then the directory, then fall back to `index.html`. This supports client-side routing if you add a SPA framework later. |

---

## 10. Upload Page — Line-by-Line

### Tailwind CSS Configuration

```html
<script src="https://cdn.tailwindcss.com"></script>
```

**Tailwind via CDN** — No build step, no `node_modules`, no PostCSS. The CDN version includes a JIT (Just-In-Time) compiler that scans your HTML and generates only the CSS classes you actually use. Trade-off: adds ~300ms page load for the JIT compilation, fine for internal tools, not ideal for production public-facing apps.

```javascript
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        ink: '#1a1a2e',
        paper: '#faf9f6',
        accent: '#e85d04',
        muted: '#6b7280',
        surface: '#f0ede8',
      }
    }
  }
}
```

Custom theme extends Tailwind's defaults. `ink` and `paper` create a warm document-like palette. `accent` (orange) is used for interactive elements and highlights.

### Drag-and-Drop Implementation

```javascript
['dragenter','dragover'].forEach(e => {
  dropZone.addEventListener(e, (ev) => {
    ev.preventDefault();
    dropZone.classList.add('drop-active');
  });
});
```

**Why `preventDefault()`?** Without it, the browser handles the drop natively — navigating away from the page to display the dropped file. `preventDefault()` tells the browser "I'll handle this myself."

**Why both `dragenter` AND `dragover`?** The browser requires `dragover` to be canceled on *every* frame to indicate the drop zone is valid. `dragenter` fires once when the cursor enters the zone. Both are needed for reliable drag-and-drop.

```javascript
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
```

`e.dataTransfer` is the Drag and Drop API's data carrier. `.files` contains the dropped files as a `FileList`. We take only the first file (`files[0]`) — single file upload.

### Upload with Progress Simulation

```javascript
const formData = new FormData();
formData.append('document', file);
```

`FormData` is the browser API for constructing `multipart/form-data` payloads. The key `'document'` must match Multer's `upload.single("document")` on the server. The browser automatically sets the `Content-Type` header with the multipart boundary.

```javascript
let progress = 0;
const progressInterval = setInterval(() => {
  progress = Math.min(progress + Math.random() * 15, 85);
  progressBar.style.width = progress + '%';
}, 300);
```

**Why simulated progress?** The `fetch` API doesn't support upload progress tracking (unlike `XMLHttpRequest`). We simulate progress up to 85% during upload, then jump to 100% on completion. This provides visual feedback without the complexity of XHR.

### File Type Visualization

```javascript
function getFileCategory(mimeType, filename) {
  if (mimeType.startsWith('image/')) return { label: 'Image', color: 'green', icon: '🖼️' };
  if (mimeType === 'application/pdf') return { label: 'PDF', color: 'red', icon: '📕' };
  if (mimeType.includes('word')) return { label: 'Word Doc', color: 'blue', icon: '📝' };
  // ...
}
```

This maps MIME types to visual categories for the result card — providing instant visual feedback about the detected file type with color-coded badges and emoji icons.

---

## 11. File Browser Page — Line-by-Line

### File Loading

```javascript
const res = await fetch('/api/files');
const data = await res.json();
allFiles = data.files || [];
```

Fetches the complete file list from the API on page load and on refresh. The `|| []` fallback prevents errors if the API returns an unexpected shape.

### Dynamic Card Rendering

```javascript
grid.innerHTML = files.map((file, i) => {
  return `
    <div class="fade-in" style="animation-delay: ${i * 60}ms">
      ...
    </div>`;
}).join('');
```

**Staggered animations:** Each card's `animation-delay` is offset by 60ms (`i * 60`), creating a cascading "waterfall" effect as cards appear. This provides a polished feel without a framework.

### Text Preview Modal

```javascript
async function viewText(textFile, originalName) {
  const res = await fetch(`/api/files/text-preview/${encodeURIComponent(textFile)}`);
  const data = await res.json();
  modalText.textContent = data.text || '(No text found)';
}
```

`encodeURIComponent` is critical — filenames may contain special characters that break URLs. The API's `/text-preview/` endpoint returns the text as JSON (vs. `/text/` which triggers a download).

### Copy to Clipboard

```javascript
navigator.clipboard.writeText(text).then(() => {
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = original, 1500);
});
```

The Clipboard API is async and requires a secure context (HTTPS or localhost). The button text changes briefly to "Copied!" as visual confirmation.

---

## 12. OCR Deep Dive

### What is OCR?

**Optical Character Recognition (OCR)** is the process of converting images of text into machine-encoded text. It's the technology that lets you search a scanned document, copy text from a photo, or digitize printed books.

### How Tesseract Works Internally

```
Input Image
    │
    ▼
┌─────────────────────┐
│  1. PREPROCESSING    │   Binarization, noise removal, deskewing
│     (Leptonica)      │   Convert to black-and-white, straighten
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  2. PAGE LAYOUT      │   Detect text blocks, columns, tables
│     ANALYSIS         │   Identify reading order
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  3. LINE/WORD        │   Segment text into lines, then words
│     SEGMENTATION     │   Handle spacing and word boundaries
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  4. CHARACTER         │   LSTM neural network recognizes each
│     RECOGNITION       │   character using trained language model
│     (LSTM Engine)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  5. POST-PROCESSING   │   Dictionary lookup, spell checking,
│     & CORRECTION      │   confidence scoring
└──────────┬──────────┘
           │
           ▼
      Output Text
```

### OCR Accuracy Factors

| Factor | Impact | Our Setting |
|--------|--------|-------------|
| **Image Resolution** | Higher DPI = more detail for character recognition | 300 DPI (via pdftoppm `-r 300`) |
| **Image Quality** | Blurry, low-contrast, or noisy images reduce accuracy | No preprocessing (see Extending section) |
| **Font Type** | Printed text: 95%+ accuracy. Handwriting: 60-80%. | Optimized for printed text |
| **Language** | Each language needs a trained model | English only (`tesseract-ocr-eng`) |
| **Page Layout** | Complex layouts (multi-column, tables) are harder | PSM 3: fully automatic detection |
| **Skew/Rotation** | Tilted text confuses line segmentation | Tesseract auto-deskews (PSM 3) |

### OCR for PDFs — The Full Pipeline

```
Input: report.pdf (3 pages)
         │
         ▼
    ┌─────────┐
    │ pdftoppm │   Poppler renders each page at 300 DPI
    └────┬────┘
         │
         ├──► page-01.png (2550 x 3300 px)
         ├──► page-02.png (2550 x 3300 px)
         └──► page-03.png (2550 x 3300 px)
                   │
                   ▼ (each page independently)
              ┌───────────┐
              │ Tesseract  │
              │   OCR      │
              └─────┬─────┘
                    │
                    ▼
    --- Page 1 ---
    [extracted text from page 1]

    --- Page 2 ---
    [extracted text from page 2]

    --- Page 3 ---
    [extracted text from page 3]
         │
         ▼
    Saved as: report.txt
```

---

## 13. Dependency Reference

### System-Level Dependencies

| Dependency | Installed In | Package Manager | Size Impact | Purpose |
|-----------|-------------|----------------|-------------|---------|
| Node.js 18 | API container | Base image | ~50MB (Alpine) | JavaScript runtime |
| Python 3.11 | OCR container | Base image | ~150MB (Slim) | OCR service runtime |
| Nginx | App container | Base image | ~25MB (Alpine) | Static file server + reverse proxy |
| Tesseract 5.x | OCR container | apt-get | ~30MB | OCR engine |
| Tesseract English data | OCR container | apt-get | ~15MB | Language model for English text recognition |
| Poppler Utils | OCR container | apt-get | ~10MB | PDF-to-image conversion (`pdftoppm`) |
| libglib2.0 | OCR container | apt-get | ~5MB | Runtime dependency for Poppler |

### Node.js Dependencies (API Service)

| Package | Version | License | Weekly Downloads | Purpose |
|---------|---------|---------|-----------------|---------|
| express | ^4.18.2 | MIT | ~30M | Web framework |
| multer | ^1.4.5-lts.1 | MIT | ~2M | File upload handling |
| cors | ^2.8.5 | MIT | ~10M | Cross-origin headers |
| mime-types | ^2.1.35 | MIT | ~30M | MIME type detection |
| node-fetch | ^2.7.0 | MIT | ~35M | HTTP client (CommonJS) |
| form-data | ^4.0.0 | MIT | ~25M | Multipart form construction |

### Python Dependencies (OCR Service)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| Flask | 3.0.0 | BSD-3 | Micro web framework |
| Gunicorn | 21.2.0 | MIT | Production WSGI server |

---

## 14. Data Flow Walkthrough

### Scenario: User uploads `receipt.jpg`

```
Step 1: Browser
────────────────
User drops receipt.jpg onto the upload zone.
JavaScript creates a FormData object:
  formData.append('document', file)  // key must be 'document'
POST /api/upload with Content-Type: multipart/form-data

Step 2: Nginx (port 8080)
──────────────────────────
Receives the request. URL starts with /api/ so it
proxies to http://api:3000/api/upload.
The 50M client_max_body_size allows the file through.

Step 3: Express + Multer (port 3000)
─────────────────────────────────────
Multer intercepts the request, reads the multipart body,
and writes the file to disk:
  /app/uploads/originals/1706900000000-receipt.jpg

The handler checks the MIME type:
  mime.lookup("receipt.jpg") → "image/jpeg"
  IMAGE_TYPES.includes("image/jpeg") → true
  → Route to OCR!

Step 4: API → OCR Service
─────────────────────────
API creates a new FormData with the saved file as a stream:
  form.append("file", fs.createReadStream(filePath))
POST http://ocr:5000/ocr

Step 5: OCR Service (port 5000)
───────────────────────────────
Flask receives the file, saves to a temp file:
  /tmp/tmpXXXXXX.jpg
Extension is .jpg → not PDF → call ocr_image()
Tesseract runs:
  tesseract /tmp/tmpXXXXXX.jpg stdout --oem 3 --psm 3
Returns extracted text to API:
  {"text": "GROCERY STORE\nMilk $3.99\nBread $2.49\n...", "success": true}
Temp file deleted.

Step 6: API Saves Text
──────────────────────
API writes the OCR text to:
  /app/uploads/text/1706900000000-receipt.txt
Returns full response to browser.

Step 7: Browser Shows Result
────────────────────────────
JavaScript renders a result card showing:
  - File type badge: "Image" (green)
  - OCR badge: "OCR Complete" (green checkmark)
  - Text preview: first 800 characters
  - Download buttons for original and .txt
```

---

## 15. Docker Networking Explained

### DNS Resolution on `docnet`

When you define a service named `ocr` in Docker Compose and attach it to `docnet`, Docker's embedded DNS server (at `127.0.0.11`) creates a DNS record mapping `ocr` to the container's IP address.

```
Container: docupload-api
  DNS lookup: ocr → 172.18.0.4 (docupload-ocr's IP)
  HTTP request: http://172.18.0.4:5000/ocr

Container: docupload-app (Nginx)
  DNS lookup: api → 172.18.0.3 (docupload-api's IP)
  Proxy: http://172.18.0.3:3000/api/*
```

### Port Mapping vs. Internal Communication

```
                    HOST                    DOCKER NETWORK (docnet)
                ┌──────────┐           ┌──────────────────────────┐
                │          │           │                          │
 Browser ──────►│ :8080 ───┼──────────►│ app:80                   │
                │          │           │   │                      │
                │ :3000 ───┼──────────►│   └──► api:3000          │
                │          │           │          │                │
                │ :5000 ───┼──────────►│          └──► ocr:5000   │
                │          │           │                          │
                └──────────┘           └──────────────────────────┘

 External (ports:)                      Internal (service names)
 - For browser/debugging access         - For inter-container communication
 - Uses HOST:CONTAINER mapping           - Uses service name as hostname
```

---

## 16. Volume & Storage Architecture

### Named Volume vs. Bind Mount

```
Named Volume (what we use):
  docker-compose.yml: volumes: uploads:/app/uploads
  Docker manages the data at: /var/lib/docker/volumes/docupload_uploads/_data
  Survives: docker compose down
  Deleted by: docker compose down -v

Bind Mount (alternative):
  docker-compose.yml: volumes: ./uploads:/app/uploads
  Data lives in your project directory
  Easier to inspect, but platform-dependent performance
```

### File Organization

```
/app/uploads/                           (Docker volume root)
├── originals/                          (uploaded files as-is)
│   ├── 1706900000000-receipt.jpg       (timestamped to avoid collisions)
│   ├── 1706900001000-contract.pdf
│   └── 1706900002000-notes.txt         (non-OCR files stored here too)
└── text/                               (OCR-extracted text)
    ├── 1706900000000-receipt.txt        (text from the jpg)
    └── 1706900001000-contract.txt       (text from the PDF, all pages)
```

**Naming convention:** The original and text files share the same base name (timestamp + sanitized original name), differing only in extension. This creates a simple 1:1 mapping without needing a database.

---

## 17. Security Considerations

| Concern | Current State | Production Recommendation |
|---------|--------------|--------------------------|
| **File validation** | Extension-based MIME detection | Add magic byte validation (e.g., `file-type` npm package) |
| **Path traversal** | Filename sanitized with regex | Also validate no `..` in paths |
| **File size** | 50MB limit (Multer + Nginx) | Adjust based on use case |
| **CORS** | Wide open (`cors()`) | Restrict to specific origins |
| **Authentication** | None | Add JWT, OAuth, or API keys |
| **HTTPS** | None (HTTP only) | Add TLS termination at Nginx |
| **Rate limiting** | None | Add `express-rate-limit` |
| **Input sanitization** | Basic XSS prevention (`escapeHtml`) | Use a proper sanitization library |
| **OCR injection** | Text stored as-is | Sanitize OCR output if displayed in HTML |

---

## 18. Troubleshooting Guide

### Common Issues

**"413 Request Entity Too Large"**
Nginx is rejecting the upload. Check `client_max_body_size` in `nginx.conf` matches your desired limit.

**"OCR service unavailable"**
The OCR container isn't ready when the API starts. `depends_on` only ensures start order, not readiness. The API handles this gracefully (returns `ocrError` in the response). Wait a few seconds for Tesseract to initialize.

**"Empty OCR text"**
The image may be too low-resolution, heavily compressed, or contain handwritten text. Try a higher-quality scan at 300+ DPI.

**"Container exits immediately"**
Check logs: `docker compose logs ocr`. Common causes: missing Python dependencies, Tesseract not found, port conflicts.

**Checking service health:**
```bash
# API health
curl http://localhost:3000/api/health

# OCR health (shows Tesseract version)
curl http://localhost:5000/health

# View logs
docker compose logs -f api
docker compose logs -f ocr
```

---

## 19. Extending the System

### Add More OCR Languages

```dockerfile
# In ocr-service/Dockerfile, add language packs:
RUN apt-get install -y \
    tesseract-ocr-fra \    # French
    tesseract-ocr-deu \    # German
    tesseract-ocr-spa \    # Spanish
    tesseract-ocr-chi-sim  # Chinese Simplified
```

Then update the Tesseract command to specify languages:

```python
# In app.py, add language parameter:
['tesseract', filepath, 'stdout', '--oem', '3', '--psm', '3', '-l', 'eng+fra+deu']
```

### Add Image Preprocessing for Better OCR

```python
# Install: apt-get install imagemagick
# Before OCR, enhance the image:
subprocess.run([
    'convert', filepath,
    '-resize', '300%',          # Upscale small images
    '-type', 'Grayscale',       # Convert to grayscale
    '-sharpen', '0x1',          # Sharpen text edges
    '-threshold', '50%',        # Binarize (black/white)
    preprocessed_path
])
```

### Add a Database for Metadata

Replace filesystem scanning with a database:

```yaml
# docker-compose.yml - add:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: docupload
      POSTGRES_PASSWORD: secret
    volumes:
      - pgdata:/var/lib/postgresql/data
```

### Add Full-Text Search

With extracted text stored, you can add search functionality using Elasticsearch or PostgreSQL full-text search to find documents by their content.

### Add Thumbnail Generation

```yaml
# Use ImageMagick to generate thumbnails:
  thumbnailer:
    image: dpokidov/imagemagick
    volumes:
      - uploads:/data
```

---

## 20. Quick Start

### Prerequisites

- Docker Engine 20.10+
- Docker Compose v2+
- 2 GB RAM (Tesseract is memory-intensive)
- Ports 8080, 3000, 5000 available

### Launch

```bash
# Clone or unzip the project
cd docupload

# Build and start all services
docker compose up --build

# First build takes 2-3 minutes (downloading base images + Tesseract)
# Subsequent builds take ~10 seconds (cached layers)
```

### Access

| URL | Page |
|-----|------|
| http://localhost:8080 | Upload page — drag-and-drop or click to upload |
| http://localhost:8080/files.html | File browser — list, preview, download, delete |
| http://localhost:3000/api/health | API health check (JSON) |
| http://localhost:5000/health | OCR service health check (includes Tesseract version) |

### Stop

```bash
docker compose down        # Stop containers (uploads preserved)
docker compose down -v     # Stop + delete uploaded files
```

---

## API Reference

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| `POST` | `/api/upload` | `multipart/form-data` with field `document` | `{ success, file: { filename, mimeType, ocrApplied, extractedText, ... } }` |
| `GET` | `/api/files` | — | `{ files: [{ filename, size, mimeType, uploadedAt, hasExtractedText, ... }] }` |
| `GET` | `/api/files/download/:filename` | — | Binary file download |
| `GET` | `/api/files/text/:filename` | — | Text file download |
| `GET` | `/api/files/text-preview/:filename` | — | `{ text: "..." }` |
| `DELETE` | `/api/files/:filename` | — | `{ success: true }` |
| `GET` | `/api/health` | — | `{ status: "ok", timestamp: "..." }` |

---

*Built with Docker, Node.js, Python, Tesseract OCR, Nginx, and Tailwind CSS.*
