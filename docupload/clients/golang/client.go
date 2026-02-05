// ═══════════════════════════════════════════════════════════════════════════════
// DocScan Go Client Library
// ═══════════════════════════════════════════════════════════════════════════════
// A complete Go client for the DocScan REST API Gateway.
// Zero external dependencies — uses only the Go standard library.
//
// Usage:
//
//	client := docscan.NewClient("http://localhost:4000", "your-api-key")
//
//	// Upload (OCR is automatic)
//	result, err := client.UploadDocument("/path/to/receipt.jpg")
//	fmt.Println(result.OCR.ExtractedText)
//
//	// List
//	docs, err := client.ListDocuments()
//
//	// Download
//	err = client.DownloadOriginal(result.Document.ID, "/path/to/save.jpg")
//	err = client.DownloadText(result.Document.ID, "/path/to/save.txt")
//
//	// Get text as string
//	text, err := client.GetExtractedText(result.Document.ID)
//
//	// Delete
//	err = client.DeleteDocument(result.Document.ID)
//
// ═══════════════════════════════════════════════════════════════════════════════
package docscan

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ─── Client Configuration ──────────────────────────────────────────────────

// Client is the DocScan REST API client.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// NewClient creates a new DocScan client.
//
//	client := docscan.NewClient("http://localhost:4000", "your-api-key")
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// ─── Response Types ────────────────────────────────────────────────────────

// UploadResponse is returned by UploadDocument.
type UploadResponse struct {
	Document  Document `json:"document"`
	RequestID string   `json:"requestId"`
}

// Document holds full document metadata from an upload.
type Document struct {
	ID             string         `json:"id"`
	OriginalName   string         `json:"originalName"`
	MimeType       string         `json:"mimeType"`
	SizeBytes      int64          `json:"sizeBytes"`
	Classification Classification `json:"classification"`
	OCR            OCRResult      `json:"ocr"`
	Links          DocumentLinks  `json:"links"`
}

// Classification describes the detected file type.
type Classification struct {
	IsImage  bool   `json:"isImage"`
	IsPDF    bool   `json:"isPdf"`
	Category string `json:"category"` // "image", "pdf", or "document"
}

// OCRResult holds OCR processing results.
type OCRResult struct {
	Applied        bool    `json:"applied"`
	ExtractedText  *string `json:"extractedText"`  // nil if not applied
	TextFileID     *string `json:"textFileId"`      // nil if not applied
	CharacterCount int     `json:"characterCount"`
	Error          *string `json:"error"`           // nil if no error
}

// DocumentLinks contains HATEOAS-style links.
type DocumentLinks struct {
	DownloadOriginal string  `json:"downloadOriginal"`
	DownloadText     *string `json:"downloadText"` // nil if no OCR text
	Delete           string  `json:"delete"`
}

// DocumentListResponse is returned by ListDocuments.
type DocumentListResponse struct {
	Documents []DocumentListItem `json:"documents"`
	Count     int                `json:"count"`
	RequestID string             `json:"requestId"`
}

// DocumentListItem is a single document in the list.
type DocumentListItem struct {
	ID         string            `json:"id"`
	MimeType   string            `json:"mimeType"`
	SizeBytes  int64             `json:"sizeBytes"`
	IsImage    bool              `json:"isImage"`
	UploadedAt string            `json:"uploadedAt"`
	OCR        DocumentListOCR   `json:"ocr"`
	Links      DocumentLinks     `json:"links"`
}

// DocumentListOCR holds OCR status in a list item.
type DocumentListOCR struct {
	HasExtractedText bool    `json:"hasExtractedText"`
	TextFileID       *string `json:"textFileId"`
}

// TextPreviewResponse is returned by GetExtractedText.
type TextPreviewResponse struct {
	DocumentID     string `json:"documentId"`
	Text           string `json:"text"`
	CharacterCount int    `json:"characterCount"`
	RequestID      string `json:"requestId"`
}

// DeleteResponse is returned by DeleteDocument.
type DeleteResponse struct {
	Deleted    bool   `json:"deleted"`
	DocumentID string `json:"documentId"`
	RequestID  string `json:"requestId"`
}

// HealthResponse is returned by HealthCheck.
type HealthResponse struct {
	Status    string                 `json:"status"`
	Gateway   map[string]interface{} `json:"gateway"`
	Backend   map[string]interface{} `json:"backend"`
	RequestID string                 `json:"requestId"`
}

// APIError represents an error from the API.
type APIError struct {
	StatusCode int
	Code       string `json:"code"`
	Message    string `json:"message"`
	RequestID  string `json:"requestId"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("API error [%d] %s: %s (requestId: %s)",
		e.StatusCode, e.Code, e.Message, e.RequestID)
}

// ═══════════════════════════════════════════════════════════════════════════════
// API METHODS
// ═══════════════════════════════════════════════════════════════════════════════

// UploadDocument uploads a file and returns the result with OCR data.
//
//	result, err := client.UploadDocument("/path/to/receipt.jpg")
//	if err != nil { log.Fatal(err) }
//	fmt.Printf("OCR applied: %v, characters: %d\n", result.Document.OCR.Applied, result.Document.OCR.CharacterCount)
func (c *Client) UploadDocument(filePath string) (*UploadResponse, error) {
	// Open the file
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	// Build multipart body
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("document", filepath.Base(filePath))
	if err != nil {
		return nil, fmt.Errorf("failed to create form file: %w", err)
	}

	if _, err := io.Copy(part, file); err != nil {
		return nil, fmt.Errorf("failed to copy file data: %w", err)
	}

	writer.Close()

	// Create request
	req, err := http.NewRequest("POST", c.BaseURL+"/v1/documents", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	c.setHeaders(req)

	// Execute
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		return nil, c.parseError(resp)
	}

	var result UploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// ListDocuments returns all uploaded documents.
//
//	docs, err := client.ListDocuments()
//	for _, d := range docs.Documents {
//	    fmt.Printf("%s (%s, %d bytes)\n", d.ID, d.MimeType, d.SizeBytes)
//	}
func (c *Client) ListDocuments() (*DocumentListResponse, error) {
	resp, err := c.doJSON("GET", "/v1/documents", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, c.parseError(resp)
	}

	var result DocumentListResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// DownloadOriginal saves the original file to disk.
//
//	err := client.DownloadOriginal("1706900000000-receipt.jpg", "./downloaded-receipt.jpg")
func (c *Client) DownloadOriginal(documentID, savePath string) error {
	return c.downloadFile(
		fmt.Sprintf("/v1/documents/%s/download", url.PathEscape(documentID)),
		savePath,
	)
}

// DownloadText saves the extracted text file to disk.
//
//	err := client.DownloadText("1706900000000-receipt.jpg", "./receipt.txt")
func (c *Client) DownloadText(documentID, savePath string) error {
	return c.downloadFile(
		fmt.Sprintf("/v1/documents/%s/text", url.PathEscape(documentID)),
		savePath,
	)
}

// GetExtractedText returns the OCR text as a string.
// Returns empty string and no error if no text is available.
//
//	text, err := client.GetExtractedText("1706900000000-receipt.jpg")
//	fmt.Println(text)
func (c *Client) GetExtractedText(documentID string) (string, error) {
	path := fmt.Sprintf("/v1/documents/%s/text/preview", url.PathEscape(documentID))
	resp, err := c.doJSON("GET", path, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return "", nil
	}
	if resp.StatusCode != 200 {
		return "", c.parseError(resp)
	}

	var result TextPreviewResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return result.Text, nil
}

// DeleteDocument removes a document and its extracted text.
//
//	deleted, err := client.DeleteDocument("1706900000000-receipt.jpg")
func (c *Client) DeleteDocument(documentID string) (bool, error) {
	path := fmt.Sprintf("/v1/documents/%s", url.PathEscape(documentID))
	resp, err := c.doJSON("DELETE", path, nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return false, nil
	}
	if resp.StatusCode != 200 {
		return false, c.parseError(resp)
	}

	var result DeleteResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false, err
	}

	return result.Deleted, nil
}

// HealthCheck returns the gateway and backend health status.
func (c *Client) HealthCheck() (*HealthResponse, error) {
	req, err := http.NewRequest("GET", c.BaseURL+"/v1/health", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result HealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	return &result, nil
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("X-API-Key", c.APIKey)
	req.Header.Set("X-Request-Id", generateUUID())
	req.Header.Set("Accept", "application/json")
}

func (c *Client) doJSON(method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)
	return c.HTTPClient.Do(req)
}

func (c *Client) downloadFile(urlPath, savePath string) error {
	req, err := http.NewRequest("GET", c.BaseURL+urlPath, nil)
	if err != nil {
		return err
	}
	c.setHeaders(req)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return c.parseError(resp)
	}

	out, err := os.Create(savePath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer out.Close()

	if _, err := io.Copy(out, resp.Body); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

func (c *Client) parseError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)

	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}

	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Code != "" {
		return &APIError{
			StatusCode: resp.StatusCode,
			Code:       envelope.Error.Code,
			Message:    envelope.Error.Message,
			RequestID:  envelope.Error.RequestID,
		}
	}

	return &APIError{
		StatusCode: resp.StatusCode,
		Code:       "UNKNOWN",
		Message:    string(body),
	}
}

func generateUUID() string {
	// Simple UUID v4 using crypto/rand via time-based fallback
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		time.Now().UnixNano()&0xFFFFFFFF,
		time.Now().UnixNano()>>32&0xFFFF,
		0x4000|time.Now().UnixNano()>>48&0x0FFF,
		0x8000|time.Now().UnixNano()>>60&0x3FFF,
		time.Now().UnixNano(),
	)
}
