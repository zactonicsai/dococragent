# DocScan — Document Upload & OCR Extraction

A Docker Compose application that uploads documents, detects file types, runs OCR on images/PDFs, and provides a file browser for downloads.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Frontend   │────▶│    API Server     │────▶│   OCR Service    │
│  (Nginx)     │     │  (Node/Express)   │     │ (Python/Tesseract)│
│  Port 8080   │     │   Port 3000       │     │   Port 5000      │
└──────────────┘     └───────┬──────────┘     └──────────────────┘
                             │
                     ┌───────▼──────────┐
                     │  Shared Volume   │
                     │  /app/uploads    │
                     │  ├── originals/  │
                     │  └── text/       │
                     └──────────────────┘
```

### Services

| Service | Tech | Purpose |
|---------|------|---------|
| **app** | Nginx + HTML/Tailwind | Frontend — upload page & file browser |
| **api** | Node.js / Express | Backend — file handling, type detection, OCR routing |
| **ocr** | Python / Flask / Tesseract | OCR — text extraction from images & PDFs |

## Quick Start

```bash
# Clone or copy the project, then:
docker compose up --build

# Open in browser:
# http://localhost:8080          — Upload page
# http://localhost:8080/files.html — File browser
```

## How It Works

1. **Upload** a file via drag-and-drop or file picker on the upload page
2. The **API** receives the file, saves the original to `/uploads/originals/`
3. **Type detection** checks the MIME type:
   - **Images** (PNG, JPEG, TIFF, BMP, GIF, WebP) → sent to OCR service
   - **PDFs** → converted to images, then OCR'd page by page
   - **Other files** → stored as-is (no OCR)
4. The **OCR service** runs Tesseract and returns extracted text
5. Extracted text is saved to `/uploads/text/` as a `.txt` file
6. The **file browser** page lists all uploads with options to:
   - View extracted text in a modal
   - Download the original file
   - Download the extracted `.txt`
   - Delete files

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload a document (multipart form, field: `document`) |
| GET | `/api/files` | List all uploaded files |
| GET | `/api/files/download/:filename` | Download original file |
| GET | `/api/files/text/:filename` | Download extracted text file |
| GET | `/api/files/text-preview/:filename` | Get extracted text as JSON |
| DELETE | `/api/files/:filename` | Delete a file and its text |
| GET | `/api/health` | API health check |
| GET | `ocr:5000/health` | OCR service health check |

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OCR_SERVICE_URL` | `http://ocr:5000` | URL of the OCR service |
| `UPLOAD_DIR` | `/app/uploads` | Directory for storing uploads |

## File Size Limit

- **50 MB** max per file (configurable in API's multer config and Nginx's `client_max_body_size`)

## Stopping

```bash
docker compose down            # Stop containers
docker compose down -v         # Stop + remove upload volume
```
