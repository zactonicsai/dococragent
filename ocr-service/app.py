import os
import tempfile
import subprocess
from flask import Flask, request, jsonify

app = Flask(__name__)

ALLOWED_EXTENSIONS = {
    'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp', 'pdf'
}


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def ocr_image(filepath):
    """Run Tesseract OCR on an image file."""
    try:
        result = subprocess.run(
            ['tesseract', filepath, 'stdout', '--oem', '3', '--psm', '3'],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            return result.stdout.strip()
        else:
            return f"[OCR Error] {result.stderr.strip()}"
    except subprocess.TimeoutExpired:
        return "[OCR Error] Processing timed out"
    except Exception as e:
        return f"[OCR Error] {str(e)}"


def ocr_pdf(filepath):
    """Convert PDF pages to images, then OCR each page."""
    text_parts = []
    with tempfile.TemporaryDirectory() as tmpdir:
        # Convert PDF to images using pdftoppm (poppler)
        try:
            subprocess.run(
                ['pdftoppm', '-png', '-r', '300', filepath,
                 os.path.join(tmpdir, 'page')],
                capture_output=True, timeout=120, check=True
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            return f"[PDF Error] Could not convert PDF: {str(e)}"

        # OCR each page image
        page_images = sorted([
            f for f in os.listdir(tmpdir) if f.endswith('.png')
        ])

        for i, img_name in enumerate(page_images, 1):
            img_path = os.path.join(tmpdir, img_name)
            page_text = ocr_image(img_path)
            text_parts.append(f"--- Page {i} ---\n{page_text}")

    return "\n\n".join(text_parts) if text_parts else "[No text extracted from PDF]"


@app.route('/ocr', methods=['POST'])
def process_ocr():
    """Receive a file and return extracted text."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': f'Unsupported file type: {file.filename}'}), 400

    # Save to temp file
    ext = file.filename.rsplit('.', 1)[1].lower()
    with tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

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
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        os.unlink(tmp_path)


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    # Verify tesseract is available
    try:
        result = subprocess.run(
            ['tesseract', '--version'], capture_output=True, text=True
        )
        tess_version = result.stdout.split('\n')[0]
    except Exception:
        tess_version = 'unavailable'

    return jsonify({
        'status': 'ok',
        'tesseract': tess_version
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
