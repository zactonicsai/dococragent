package com.docupload;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.UUID;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DocScan Java Client
 * ═══════════════════════════════════════════════════════════════════════════
 * A complete Java client for the DocScan REST API Gateway.
 *
 * Usage:
 *   // Initialize
 *   DocScanClient client = new DocScanClient("http://localhost:4000", "your-api-key");
 *
 *   // Upload a file (OCR is automatic for images/PDFs)
 *   UploadResult result = client.uploadDocument("/path/to/receipt.jpg");
 *   System.out.println("Extracted text: " + result.extractedText);
 *
 *   // List all documents
 *   DocumentList docs = client.listDocuments();
 *
 *   // Download original
 *   client.downloadOriginal(result.documentId, "/path/to/save/receipt.jpg");
 *
 *   // Download extracted text
 *   client.downloadText(result.documentId, "/path/to/save/receipt.txt");
 *
 *   // Get text as string (for programmatic use)
 *   String text = client.getExtractedText(result.documentId);
 *
 *   // Delete
 *   client.deleteDocument(result.documentId);
 *
 * Requirements: Java 11+, Gson dependency
 * ═══════════════════════════════════════════════════════════════════════════
 */
public class DocScanClient {

    private final String baseUrl;
    private final String apiKey;
    private final Gson gson;
    private final int timeoutMs;

    // ─── Configuration ─────────────────────────────────────────────────────

    /**
     * Create a new DocScan client.
     *
     * @param baseUrl  Gateway URL, e.g., "http://localhost:4000"
     * @param apiKey   API key for authentication
     */
    public DocScanClient(String baseUrl, String apiKey) {
        this(baseUrl, apiKey, 120_000);
    }

    public DocScanClient(String baseUrl, String apiKey, int timeoutMs) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.apiKey = apiKey;
        this.timeoutMs = timeoutMs;
        this.gson = new GsonBuilder().setPrettyPrinting().create();
    }

    // ─── Data Classes ──────────────────────────────────────────────────────

    /** Result from uploading a document. */
    public static class UploadResult {
        public String documentId;
        public String originalName;
        public String mimeType;
        public long sizeBytes;
        public String category;
        public boolean ocrApplied;
        public String extractedText;
        public String textFileId;
        public int characterCount;
        public String ocrError;
        public String requestId;

        @Override
        public String toString() {
            return String.format(
                "UploadResult{id='%s', name='%s', mime='%s', size=%d, category='%s', ocr=%b, chars=%d}",
                documentId, originalName, mimeType, sizeBytes, category, ocrApplied, characterCount
            );
        }
    }

    /** A single document in the list. */
    public static class DocumentInfo {
        public String id;
        public String mimeType;
        public long sizeBytes;
        public boolean isImage;
        public String uploadedAt;
        public boolean hasExtractedText;
        public String textFileId;

        @Override
        public String toString() {
            return String.format("Document{id='%s', mime='%s', size=%d, ocr=%b}",
                id, mimeType, sizeBytes, hasExtractedText);
        }
    }

    /** List of documents. */
    public static class DocumentList {
        public DocumentInfo[] documents;
        public int count;
        public String requestId;
    }

    /** API error. */
    public static class ApiException extends RuntimeException {
        public final int statusCode;
        public final String errorCode;
        public final String requestId;

        public ApiException(int statusCode, String errorCode, String message, String requestId) {
            super(message);
            this.statusCode = statusCode;
            this.errorCode = errorCode;
            this.requestId = requestId;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // API METHODS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Upload a document to DocScan.
     * If the file is an image or PDF, OCR is performed automatically.
     *
     * @param filePath  Path to the file to upload
     * @return          Upload result with document metadata and OCR results
     */
    public UploadResult uploadDocument(String filePath) throws IOException {
        Path path = Paths.get(filePath);
        if (!Files.exists(path)) {
            throw new FileNotFoundException("File not found: " + filePath);
        }

        String fileName = path.getFileName().toString();
        String mimeType = Files.probeContentType(path);
        if (mimeType == null) mimeType = "application/octet-stream";

        // Build multipart/form-data request
        String boundary = "----DocScanBoundary" + UUID.randomUUID().toString().replace("-", "");
        URL url = new URL(baseUrl + "/v1/documents");
        HttpURLConnection conn = createConnection(url, "POST");
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        conn.setDoOutput(true);

        // Write multipart body
        try (OutputStream out = conn.getOutputStream()) {
            PrintWriter writer = new PrintWriter(new OutputStreamWriter(out, "UTF-8"), true);

            // File part
            writer.append("--").append(boundary).append("\r\n");
            writer.append("Content-Disposition: form-data; name=\"document\"; filename=\"")
                  .append(fileName).append("\"\r\n");
            writer.append("Content-Type: ").append(mimeType).append("\r\n");
            writer.append("\r\n");
            writer.flush();

            // Stream file bytes
            Files.copy(path, out);
            out.flush();

            // End boundary
            writer.append("\r\n");
            writer.append("--").append(boundary).append("--\r\n");
            writer.flush();
        }

        // Parse response
        int status = conn.getResponseCode();
        String responseBody = readResponse(conn);

        if (status != 201 && status != 200) {
            handleError(status, responseBody);
        }

        JsonObject json = gson.fromJson(responseBody, JsonObject.class);
        JsonObject doc = json.getAsJsonObject("document");
        JsonObject classification = doc.getAsJsonObject("classification");
        JsonObject ocr = doc.getAsJsonObject("ocr");

        UploadResult result = new UploadResult();
        result.documentId = getStr(doc, "id");
        result.originalName = getStr(doc, "originalName");
        result.mimeType = getStr(doc, "mimeType");
        result.sizeBytes = doc.get("sizeBytes").getAsLong();
        result.category = getStr(classification, "category");
        result.ocrApplied = ocr.get("applied").getAsBoolean();
        result.extractedText = getStrNullable(ocr, "extractedText");
        result.textFileId = getStrNullable(ocr, "textFileId");
        result.characterCount = ocr.get("characterCount").getAsInt();
        result.ocrError = getStrNullable(ocr, "error");
        result.requestId = getStr(json, "requestId");

        return result;
    }

    /**
     * List all uploaded documents.
     */
    public DocumentList listDocuments() throws IOException {
        URL url = new URL(baseUrl + "/v1/documents");
        HttpURLConnection conn = createConnection(url, "GET");

        int status = conn.getResponseCode();
        String body = readResponse(conn);

        if (status != 200) handleError(status, body);

        JsonObject json = gson.fromJson(body, JsonObject.class);
        JsonArray arr = json.getAsJsonArray("documents");

        DocumentList list = new DocumentList();
        list.count = json.get("count").getAsInt();
        list.requestId = getStr(json, "requestId");
        list.documents = new DocumentInfo[arr.size()];

        for (int i = 0; i < arr.size(); i++) {
            JsonObject d = arr.get(i).getAsJsonObject();
            JsonObject ocr = d.getAsJsonObject("ocr");
            DocumentInfo info = new DocumentInfo();
            info.id = getStr(d, "id");
            info.mimeType = getStr(d, "mimeType");
            info.sizeBytes = d.get("sizeBytes").getAsLong();
            info.isImage = d.get("isImage").getAsBoolean();
            info.uploadedAt = getStr(d, "uploadedAt");
            info.hasExtractedText = ocr.get("hasExtractedText").getAsBoolean();
            info.textFileId = getStrNullable(ocr, "textFileId");
            list.documents[i] = info;
        }

        return list;
    }

    /**
     * Download the original file.
     *
     * @param documentId  Document ID (from upload result or list)
     * @param savePath    Local path to save the downloaded file
     */
    public void downloadOriginal(String documentId, String savePath) throws IOException {
        downloadFile("/v1/documents/" + encode(documentId) + "/download", savePath);
    }

    /**
     * Download the extracted text file.
     *
     * @param documentId  Document ID
     * @param savePath    Local path to save the .txt file
     */
    public void downloadText(String documentId, String savePath) throws IOException {
        downloadFile("/v1/documents/" + encode(documentId) + "/text", savePath);
    }

    /**
     * Get extracted text as a String (for programmatic use).
     *
     * @param documentId  Document ID
     * @return            Extracted text, or null if no OCR text available
     */
    public String getExtractedText(String documentId) throws IOException {
        URL url = new URL(baseUrl + "/v1/documents/" + encode(documentId) + "/text/preview");
        HttpURLConnection conn = createConnection(url, "GET");

        int status = conn.getResponseCode();
        if (status == 404) return null;

        String body = readResponse(conn);
        if (status != 200) handleError(status, body);

        JsonObject json = gson.fromJson(body, JsonObject.class);
        return getStrNullable(json, "text");
    }

    /**
     * Delete a document and its extracted text.
     *
     * @param documentId  Document ID
     * @return            true if deleted successfully
     */
    public boolean deleteDocument(String documentId) throws IOException {
        URL url = new URL(baseUrl + "/v1/documents/" + encode(documentId));
        HttpURLConnection conn = createConnection(url, "DELETE");

        int status = conn.getResponseCode();
        String body = readResponse(conn);

        if (status == 404) return false;
        if (status != 200) handleError(status, body);

        JsonObject json = gson.fromJson(body, JsonObject.class);
        return json.get("deleted").getAsBoolean();
    }

    /**
     * Check gateway health.
     */
    public String healthCheck() throws IOException {
        URL url = new URL(baseUrl + "/v1/health");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(5000);
        return readResponse(conn);
    }

    // ─── Internal Helpers ──────────────────────────────────────────────────

    private HttpURLConnection createConnection(URL url, String method) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setRequestProperty("X-API-Key", apiKey);
        conn.setRequestProperty("X-Request-Id", UUID.randomUUID().toString());
        conn.setRequestProperty("Accept", "application/json");
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        return conn;
    }

    private void downloadFile(String path, String savePath) throws IOException {
        URL url = new URL(baseUrl + path);
        HttpURLConnection conn = createConnection(url, "GET");

        int status = conn.getResponseCode();
        if (status != 200) {
            String body = readResponse(conn);
            handleError(status, body);
        }

        try (InputStream in = conn.getInputStream()) {
            Files.copy(in, Paths.get(savePath), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private String readResponse(HttpURLConnection conn) throws IOException {
        InputStream stream;
        try {
            stream = conn.getInputStream();
        } catch (IOException e) {
            stream = conn.getErrorStream();
        }
        if (stream == null) return "";

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
            return sb.toString().trim();
        }
    }

    private void handleError(int status, String body) {
        try {
            JsonObject json = gson.fromJson(body, JsonObject.class);
            JsonObject error = json.getAsJsonObject("error");
            throw new ApiException(
                status,
                getStr(error, "code"),
                getStr(error, "message"),
                getStrNullable(error, "requestId")
            );
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            throw new ApiException(status, "UNKNOWN", body, null);
        }
    }

    private static String getStr(JsonObject obj, String key) {
        return obj.has(key) && !obj.get(key).isJsonNull() ? obj.get(key).getAsString() : "";
    }

    private static String getStrNullable(JsonObject obj, String key) {
        return obj.has(key) && !obj.get(key).isJsonNull() ? obj.get(key).getAsString() : null;
    }

    private static String encode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MAIN — Interactive Demo
    // ═══════════════════════════════════════════════════════════════════════

    public static void main(String[] args) {
        // ── Configuration ──
        String gatewayUrl = System.getenv("DOCSCAN_URL") != null
            ? System.getenv("DOCSCAN_URL") : "http://localhost:4000";
        String apiKey = System.getenv("DOCSCAN_API_KEY") != null
            ? System.getenv("DOCSCAN_API_KEY") : "docupload-dev-key-change-me";

        DocScanClient client = new DocScanClient(gatewayUrl, apiKey);

        System.out.println("═══════════════════════════════════════════════");
        System.out.println("  DocScan Java Client Demo");
        System.out.println("  Gateway: " + gatewayUrl);
        System.out.println("═══════════════════════════════════════════════");

        try {
            // ── Health Check ──
            System.out.println("\n[1] Health check...");
            String health = client.healthCheck();
            System.out.println("    " + health);

            // ── Upload ──
            if (args.length > 0) {
                String filePath = args[0];
                System.out.println("\n[2] Uploading: " + filePath);
                UploadResult result = client.uploadDocument(filePath);
                System.out.println("    Document ID:  " + result.documentId);
                System.out.println("    MIME type:    " + result.mimeType);
                System.out.println("    Category:     " + result.category);
                System.out.println("    Size:         " + result.sizeBytes + " bytes");
                System.out.println("    OCR applied:  " + result.ocrApplied);
                System.out.println("    Characters:   " + result.characterCount);

                if (result.extractedText != null) {
                    String preview = result.extractedText.length() > 200
                        ? result.extractedText.substring(0, 200) + "..."
                        : result.extractedText;
                    System.out.println("    Text preview: " + preview);
                }

                // ── Get text programmatically ──
                System.out.println("\n[3] Getting extracted text...");
                String text = client.getExtractedText(result.documentId);
                if (text != null) {
                    System.out.println("    Got " + text.length() + " characters");
                } else {
                    System.out.println("    No extracted text available");
                }
            } else {
                System.out.println("\n[2] Skipping upload (pass a file path as argument)");
                System.out.println("    Usage: java -jar docupload-client.jar /path/to/file.jpg");
            }

            // ── List Documents ──
            System.out.println("\n[4] Listing all documents...");
            DocumentList docs = client.listDocuments();
            System.out.println("    Total: " + docs.count + " documents");
            for (DocumentInfo doc : docs.documents) {
                System.out.printf("    • %s (%s, %d bytes, OCR: %b)%n",
                    doc.id, doc.mimeType, doc.sizeBytes, doc.hasExtractedText);
            }

        } catch (ApiException e) {
            System.err.printf("API Error [%d] %s: %s (reqId: %s)%n",
                e.statusCode, e.errorCode, e.getMessage(), e.requestId);
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
