# DocScan REST API — Client SDK & Examples

## Gateway Endpoint

The REST API Gateway runs on **port 4000** and provides a language-agnostic, versioned REST API that any HTTP client can consume.

```
Base URL:  http://localhost:4000
Auth:      X-API-Key header
Version:   /v1/*
Spec:      http://localhost:4000/v1/docs
```

---

## Quick Start: curl Examples

### Health Check (no auth required)

```bash
curl http://localhost:4000/v1/health | jq
```

### Upload a Document

```bash
curl -X POST http://localhost:4000/v1/documents \
  -H "X-API-Key: docupload-dev-key-change-me" \
  -F "document=@/path/to/receipt.jpg" | jq
```

**Response:**
```json
{
  "document": {
    "id": "1706900000000-receipt.jpg",
    "originalName": "receipt.jpg",
    "mimeType": "image/jpeg",
    "sizeBytes": 245760,
    "classification": {
      "isImage": true,
      "isPdf": false,
      "category": "image"
    },
    "ocr": {
      "applied": true,
      "extractedText": "GROCERY STORE\nMilk $3.99\nBread $2.49...",
      "textFileId": "1706900000000-receipt.txt",
      "characterCount": 342,
      "error": null
    },
    "links": {
      "downloadOriginal": "/v1/documents/1706900000000-receipt.jpg/download",
      "downloadText": "/v1/documents/1706900000000-receipt.jpg/text",
      "delete": "/v1/documents/1706900000000-receipt.jpg"
    }
  },
  "requestId": "a1b2c3d4-..."
}
```

### List All Documents

```bash
curl http://localhost:4000/v1/documents \
  -H "X-API-Key: docupload-dev-key-change-me" | jq
```

### Download Original File

```bash
curl -O http://localhost:4000/v1/documents/1706900000000-receipt.jpg/download \
  -H "X-API-Key: docupload-dev-key-change-me"
```

### Download Extracted Text

```bash
curl -O http://localhost:4000/v1/documents/1706900000000-receipt.jpg/text \
  -H "X-API-Key: docupload-dev-key-change-me"
```

### Get Extracted Text as JSON

```bash
curl http://localhost:4000/v1/documents/1706900000000-receipt.jpg/text/preview \
  -H "X-API-Key: docupload-dev-key-change-me" | jq
```

### Delete a Document

```bash
curl -X DELETE http://localhost:4000/v1/documents/1706900000000-receipt.jpg \
  -H "X-API-Key: docupload-dev-key-change-me" | jq
```

---

## Python Client (requests)

```python
import requests

BASE = "http://localhost:4000"
HEADERS = {"X-API-Key": "docupload-dev-key-change-me"}

# Upload
with open("receipt.jpg", "rb") as f:
    resp = requests.post(f"{BASE}/v1/documents",
                         headers=HEADERS,
                         files={"document": f})
    doc = resp.json()["document"]
    print(f"ID: {doc['id']}, OCR chars: {doc['ocr']['characterCount']}")

# List
docs = requests.get(f"{BASE}/v1/documents", headers=HEADERS).json()
for d in docs["documents"]:
    print(f"  {d['id']} ({d['mimeType']})")

# Get text
text = requests.get(f"{BASE}/v1/documents/{doc['id']}/text/preview",
                    headers=HEADERS).json()["text"]

# Delete
requests.delete(f"{BASE}/v1/documents/{doc['id']}", headers=HEADERS)
```

---

## Java Client

**Location:** `clients/java/`

**Requirements:** Java 11+, Maven

```bash
cd clients/java
mvn package
java -jar target/docupload-client-1.0.0.jar /path/to/receipt.jpg
```

**Programmatic usage:**

```java
DocScanClient client = new DocScanClient("http://localhost:4000", "docupload-dev-key-change-me");

// Upload (OCR is automatic for images/PDFs)
UploadResult result = client.uploadDocument("/path/to/receipt.jpg");
System.out.println("OCR text: " + result.extractedText);
System.out.println("Characters: " + result.characterCount);

// List all documents
DocumentList docs = client.listDocuments();
for (DocumentInfo doc : docs.documents) {
    System.out.println(doc.id + " - " + doc.mimeType);
}

// Download original and text
client.downloadOriginal(result.documentId, "./downloaded-receipt.jpg");
client.downloadText(result.documentId, "./receipt.txt");

// Get text as String
String text = client.getExtractedText(result.documentId);

// Delete
client.deleteDocument(result.documentId);
```

**Key classes:**
| Class | Purpose |
|-------|---------|
| `DocScanClient` | Main client — all API methods |
| `UploadResult` | Upload response with OCR data |
| `DocumentInfo` | Document metadata in lists |
| `DocumentList` | List response with count |
| `ApiException` | Structured API error with code and requestId |

---

## Go Client

**Location:** `clients/golang/`

**Requirements:** Go 1.21+

```bash
cd clients/golang

# Build CLI
go build -o docscan-cli ./cmd/main.go

# Upload
./docscan-cli upload /path/to/receipt.jpg

# List
./docscan-cli list

# Get OCR text
./docscan-cli text <document-id>

# Download
./docscan-cli download <document-id> ./saved.jpg

# Delete
./docscan-cli delete <document-id>

# Health
./docscan-cli health
```

**Programmatic usage (import as library):**

```go
package main

import (
    "fmt"
    "log"
    docscan "github.com/docupload/docscan-client"
)

func main() {
    client := docscan.NewClient("http://localhost:4000", "docupload-dev-key-change-me")

    // Upload (OCR automatic)
    result, err := client.UploadDocument("/path/to/receipt.jpg")
    if err != nil { log.Fatal(err) }

    fmt.Printf("ID: %s\n", result.Document.ID)
    fmt.Printf("OCR applied: %v\n", result.Document.OCR.Applied)
    fmt.Printf("Characters: %d\n", result.Document.OCR.CharacterCount)

    if result.Document.OCR.ExtractedText != nil {
        fmt.Printf("Text: %s\n", *result.Document.OCR.ExtractedText)
    }

    // List
    docs, _ := client.ListDocuments()
    for _, d := range docs.Documents {
        fmt.Printf("  %s (%s)\n", d.ID, d.MimeType)
    }

    // Download
    client.DownloadOriginal(result.Document.ID, "./saved.jpg")
    client.DownloadText(result.Document.ID, "./saved.txt")

    // Get text as string
    text, _ := client.GetExtractedText(result.Document.ID)
    fmt.Println(text)

    // Delete
    deleted, _ := client.DeleteDocument(result.Document.ID)
    fmt.Printf("Deleted: %v\n", deleted)
}
```

**Key types:**
| Type | Purpose |
|------|---------|
| `Client` | Main client with `BaseURL`, `APIKey`, configurable `HTTPClient` |
| `UploadResponse` | Full upload result with nested `Document` |
| `Document` | Document metadata, classification, OCR result, links |
| `OCRResult` | OCR applied status, extracted text, character count, errors |
| `DocumentListItem` | Document in list with OCR status |
| `APIError` | Structured error implementing `error` interface |

---

## API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/v1/health` | No | Gateway + backend health status |
| `POST` | `/v1/documents` | Yes | Upload a document (multipart, field: `document`) |
| `GET` | `/v1/documents` | Yes | List all documents |
| `GET` | `/v1/documents/{id}/download` | Yes | Download original file |
| `GET` | `/v1/documents/{id}/text` | Yes | Download extracted text (.txt) |
| `GET` | `/v1/documents/{id}/text/preview` | Yes | Get extracted text as JSON |
| `DELETE` | `/v1/documents/{id}` | Yes | Delete document + text |
| `GET` | `/v1/openapi.yaml` | No | OpenAPI 3.0 spec |

## Authentication

Every request (except health and docs) requires the `X-API-Key` header:

```
X-API-Key: docupload-dev-key-change-me
```

## Rate Limiting

Default: **100 requests per 60 seconds** per API key.

Response headers:
- `X-RateLimit-Limit` — Max requests per window
- `X-RateLimit-Remaining` — Remaining requests
- `X-RateLimit-Reset` — Window reset time

## Error Format

All errors return a consistent envelope:

```json
{
  "error": {
    "code": "MISSING_API_KEY",
    "message": "X-API-Key header is required.",
    "requestId": "a1b2c3d4-..."
  }
}
```

| Error Code | HTTP Status | Meaning |
|-----------|-------------|---------|
| `MISSING_API_KEY` | 401 | No X-API-Key header |
| `INVALID_API_KEY` | 403 | Wrong API key |
| `NO_FILE` | 400 | No file in request |
| `UPLOAD_FAILED` | 500 | Backend upload error |
| `NOT_FOUND` | 404 | Document doesn't exist |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
