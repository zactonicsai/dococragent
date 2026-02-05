// ═══════════════════════════════════════════════════════════════════════════════
// DocScan Go Client — Demo / CLI Tool
// ═══════════════════════════════════════════════════════════════════════════════
//
// Build:   go build -o docscan-cli ./cmd/main.go
// Run:     ./docscan-cli upload /path/to/receipt.jpg
//          ./docscan-cli list
//          ./docscan-cli download <document-id> /path/to/save
//          ./docscan-cli text <document-id>
//          ./docscan-cli delete <document-id>
//          ./docscan-cli health
//
// Environment:
//   DOCSCAN_URL      Gateway URL  (default: http://localhost:4000)
//   DOCSCAN_API_KEY  API key      (default: docupload-dev-key-change-me)
//
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"fmt"
	"os"
	"strings"

	docscan "github.com/docupload/docscan-client"
)

func main() {
	// ── Configuration ──
	gatewayURL := envOr("DOCSCAN_URL", "http://localhost:4000")
	apiKey := envOr("DOCSCAN_API_KEY", "docupload-dev-key-change-me")

	client := docscan.NewClient(gatewayURL, apiKey)

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	command := strings.ToLower(os.Args[1])

	switch command {

	// ── Upload ──────────────────────────────────────────────────────────
	case "upload":
		if len(os.Args) < 3 {
			fmt.Println("Usage: docscan-cli upload <file-path>")
			os.Exit(1)
		}
		filePath := os.Args[2]
		fmt.Printf("Uploading: %s\n", filePath)
		fmt.Println("─────────────────────────────────────────")

		result, err := client.UploadDocument(filePath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		doc := result.Document
		fmt.Printf("✓ Uploaded successfully\n")
		fmt.Printf("  Document ID:  %s\n", doc.ID)
		fmt.Printf("  Original:     %s\n", doc.OriginalName)
		fmt.Printf("  MIME type:    %s\n", doc.MimeType)
		fmt.Printf("  Size:         %d bytes\n", doc.SizeBytes)
		fmt.Printf("  Category:     %s\n", doc.Classification.Category)
		fmt.Printf("  OCR applied:  %v\n", doc.OCR.Applied)
		fmt.Printf("  Characters:   %d\n", doc.OCR.CharacterCount)
		fmt.Printf("  Request ID:   %s\n", result.RequestID)

		if doc.OCR.ExtractedText != nil && len(*doc.OCR.ExtractedText) > 0 {
			text := *doc.OCR.ExtractedText
			if len(text) > 300 {
				text = text[:300] + "..."
			}
			fmt.Printf("\n── Extracted Text Preview ──\n%s\n", text)
		}
		if doc.OCR.Error != nil {
			fmt.Printf("  OCR error:    %s\n", *doc.OCR.Error)
		}

	// ── List ────────────────────────────────────────────────────────────
	case "list", "ls":
		docs, err := client.ListDocuments()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("Documents: %d total\n", docs.Count)
		fmt.Println("─────────────────────────────────────────")

		if docs.Count == 0 {
			fmt.Println("  (no documents uploaded)")
			return
		}

		for i, d := range docs.Documents {
			ocrStatus := "✗"
			if d.OCR.HasExtractedText {
				ocrStatus = "✓"
			}
			fmt.Printf("  %d. [%s OCR] %s\n", i+1, ocrStatus, d.ID)
			fmt.Printf("     %s | %d bytes | %s\n", d.MimeType, d.SizeBytes, d.UploadedAt)
		}

	// ── Download ────────────────────────────────────────────────────────
	case "download", "dl":
		if len(os.Args) < 4 {
			fmt.Println("Usage: docscan-cli download <document-id> <save-path>")
			os.Exit(1)
		}
		docID, savePath := os.Args[2], os.Args[3]

		fmt.Printf("Downloading: %s → %s\n", docID, savePath)
		if err := client.DownloadOriginal(docID, savePath); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("✓ Downloaded successfully")

	// ── Get Text ────────────────────────────────────────────────────────
	case "text":
		if len(os.Args) < 3 {
			fmt.Println("Usage: docscan-cli text <document-id> [save-path]")
			os.Exit(1)
		}
		docID := os.Args[2]

		// If save path provided, download the text file
		if len(os.Args) >= 4 {
			savePath := os.Args[3]
			if err := client.DownloadText(docID, savePath); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("✓ Text saved to: %s\n", savePath)
			return
		}

		// Otherwise print to stdout
		text, err := client.GetExtractedText(docID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if text == "" {
			fmt.Println("No extracted text available for this document.")
			return
		}
		fmt.Println(text)

	// ── Delete ──────────────────────────────────────────────────────────
	case "delete", "rm":
		if len(os.Args) < 3 {
			fmt.Println("Usage: docscan-cli delete <document-id>")
			os.Exit(1)
		}
		docID := os.Args[2]

		deleted, err := client.DeleteDocument(docID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if deleted {
			fmt.Printf("✓ Deleted: %s\n", docID)
		} else {
			fmt.Printf("✗ Not found: %s\n", docID)
		}

	// ── Health ──────────────────────────────────────────────────────────
	case "health":
		health, err := client.HealthCheck()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Gateway:  %s\n", health.Status)
		fmt.Printf("Version:  %v\n", health.Gateway["version"])
		fmt.Printf("Backend:  %v\n", health.Backend["status"])

	default:
		fmt.Printf("Unknown command: %s\n", command)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`
DocScan CLI — Document Upload & OCR Client

Commands:
  upload  <file>                 Upload a document (OCR auto-applied)
  list                           List all documents
  download <id> <save-path>      Download original file
  text <id> [save-path]          Get/save extracted text
  delete <id>                    Delete a document
  health                         Check service health

Environment:
  DOCSCAN_URL       Gateway URL  (default: http://localhost:4000)
  DOCSCAN_API_KEY   API key      (default: docupload-dev-key-change-me)

Examples:
  docscan-cli upload ./receipt.jpg
  docscan-cli list
  docscan-cli text 1706900000000-receipt.jpg
  docscan-cli download 1706900000000-receipt.jpg ./saved.jpg
  docscan-cli delete 1706900000000-receipt.jpg`)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
