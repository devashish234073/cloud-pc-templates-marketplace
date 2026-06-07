import os
import sys
import tempfile
from flask import Flask, request, jsonify
from flask_cors import CORS

# Initialize Flask App
app = Flask(__name__)
CORS(app)  # Allow requests from the Angular frontend

MODEL = None
MODEL_NAME = "base"  # Options: "tiny", "base", "small", "medium", "large"

@app.route('/health', methods=['GET'])
def health():
    global MODEL
    return jsonify({
        "status": "ready" if MODEL is not None else "loading",
        "model": MODEL_NAME,
        "message": "Whisper server is running and ready." if MODEL is not None else "Model is loading..."
    })

@app.route('/transcribe', methods=['POST'])
def transcribe():
    global MODEL
    if MODEL is None:
        return jsonify({"error": "Model not loaded yet. Check startup console."}), 503

    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded."}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file."}), 400

    # Save to a temporary file
    temp_dir = tempfile.gettempdir()
    file_ext = os.path.splitext(file.filename)[1]
    temp_file_path = os.path.join(temp_dir, f"whisper_upload_{os.getpid()}{file_ext}")
    file.save(temp_file_path)

    try:
        print(f"Transcribing file: {file.filename}...")
        # Run Whisper transcription
        result = MODEL.transcribe(temp_file_path)
        
        # Clean up temporary file
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)
        
        # Format the response
        return jsonify({
            "text": result.get("text", "").strip(),
            "segments": [
                {
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "text": seg.get("text", "").strip()
                }
                for seg in result.get("segments", [])
            ]
        })
    except Exception as e:
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)
        print(f"Error during transcription: {str(e)}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Try importing Whisper
    try:
        import whisper
    except ImportError:
        print("Error: 'openai-whisper' package is not installed. Please run 'pip install openai-whisper flask flask-cors'", file=sys.stderr)
        sys.exit(1)

    print(f"Loading Whisper '{MODEL_NAME}' model (first run will download the weights if not cached)...")
    try:
        MODEL = whisper.load_model(MODEL_NAME)
        print("Whisper model loaded successfully!")
    except Exception as e:
        print(f"Failed to load Whisper model: {str(e)}", file=sys.stderr)
        sys.exit(1)

    print("Starting server on port 4301...")
    app.run(host='0.0.0.0', port=4301)