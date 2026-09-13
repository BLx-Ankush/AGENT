"""
ANTARDRISHTI — Model Download Script

Downloads open-source ONNX models for the production perception pipeline.

Models:
  1. PP-OCR-v3 det (DBNet text detector) — PaddlePaddle Apache 2.0
  2. PP-OCR-v3 rec (text recognizer) — PaddlePaddle Apache 2.0
  3. BlazeFace Short Range (face detector) — MediaPipe Apache 2.0
  4. OmniParser icon-detect (UI region detector) — Microsoft MIT

Run:
  python scripts/download-models.py
"""

import os
import hashlib
import json
import urllib.request
import urllib.error
from pathlib import Path

MODELS_DIR = Path(__file__).parent.parent / "apps" / "extension" / "assets" / "models"
MANIFEST_FILE = MODELS_DIR / "model-manifest.json"

# ── Model sources ──────────────────────────────────────────────

MODELS = [
    {
        "id": "text-detector-v1",
        "category": "text-detector",
        "filename": "text-detector.onnx",
        "description": "PP-OCRv4 DBNet text detector (Chinese/English)",
        "license": "Apache-2.0",
        "source": "PaddlePaddle / webnn/PP-OCRv4-ONNX (HuggingFace)",
        "url": "https://huggingface.co/webnn/PP-OCRv4-ONNX/resolve/main/ch_PP-OCRv4_det.onnx",
        "size_bytes_approx": 4_700_000,
        "input_shape": [1, 3, 640, 640],
        "output_names": ["sigmoid_0.tmp_0"],
    },
    {
        "id": "ocr-recognizer-v1",
        "category": "ocr-recognizer",
        "filename": "ocr-recognizer.onnx",
        "description": "PP-OCRv4 text recognizer (Chinese/English)",
        "license": "Apache-2.0",
        "source": "PaddlePaddle / webnn/PP-OCRv4-ONNX (HuggingFace)",
        "url": "https://huggingface.co/webnn/PP-OCRv4-ONNX/resolve/main/ch_PP-OCRv4_rec.onnx",
        "size_bytes_approx": 10_500_000,
        "input_shape": [1, 3, 48, -1],
        "output_names": ["softmax_2.tmp_0"],
    },
    {
        "id": "face-detector-v1",
        "category": "face-detector",
        "filename": "face-detector.onnx",
        "description": "BlazeFace Short Range face detector",
        "license": "Apache-2.0",
        "source": "Google MediaPipe / garavv/blazeface-onnx (HuggingFace)",
        "url": "https://huggingface.co/garavv/blazeface-onnx/resolve/main/blaze.onnx",
        "size_bytes_approx": 535_000,
        "input_shape": [1, 3, 128, 128],
        "output_names": ["classificators", "regressors"],
    },
    {
        "id": "ui-region-detector-v1",
        "category": "region-parser",
        "filename": "ui-region-detector.onnx",
        "description": "OmniParser icon-detect UI element detector (fp32)",
        "license": "MIT",
        "source": "Microsoft OmniParser / onnx-community/OmniParser-icon_detect (HuggingFace)",
        "url": "https://huggingface.co/onnx-community/OmniParser-icon_detect/resolve/main/onnx/model.onnx",
        "size_bytes_approx": 27_000_000,
        "input_shape": [1, 3, 640, 640],
        "output_names": ["output0"],
    },
]


def sha256_file(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def download_model(model: dict, dest: Path) -> bool:
    url = model["url"]
    dest_file = dest / model["filename"]

    if dest_file.exists():
        print(f"  ✓ Already exists: {model['filename']} ({dest_file.stat().st_size:,} bytes)")
        return True

    print(f"  ↓ Downloading: {model['filename']}")
    print(f"    URL: {url}")
    print(f"    Expected size: ~{model['size_bytes_approx'] / 1e6:.1f}MB")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ANTARDRISHTI/0.1"})
        with urllib.request.urlopen(req, timeout=120) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            with open(dest_file, "wb") as f:
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded / total * 100
                        print(f"\r    Progress: {pct:.1f}% ({downloaded:,}/{total:,} bytes)", end="", flush=True)
            print()
        print(f"  ✓ Downloaded: {dest_file.stat().st_size:,} bytes")
        return True
    except Exception as e:
        print(f"  ✗ Failed: {e}")
        if dest_file.exists():
            dest_file.unlink()
        return False


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {"models": [], "generatedAt": ""}

    import datetime
    manifest["generatedAt"] = datetime.datetime.utcnow().isoformat() + "Z"

    print("\n=== ANTARDRISHTI Model Downloader ===\n")
    print(f"Target directory: {MODELS_DIR}\n")

    success_count = 0
    for model in MODELS:
        print(f"[{model['id']}] {model['description']}")
        print(f"  License: {model['license']} | Source: {model['source']}")

        ok = download_model(model, MODELS_DIR)

        if ok:
            dest_file = MODELS_DIR / model["filename"]
            sha256 = sha256_file(dest_file)
            size = dest_file.stat().st_size

            manifest["models"].append({
                "id": model["id"],
                "category": model["category"],
                "filename": model["filename"],
                "description": model["description"],
                "license": model["license"],
                "source": model["source"],
                "sha256": sha256,
                "sizeBytes": size,
                "inputShape": model["input_shape"],
                "outputNames": model["output_names"],
            })

            print(f"  SHA-256: {sha256[:16]}…")
            success_count += 1
        print()

    # Write manifest
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"=== Download complete: {success_count}/{len(MODELS)} models ===")
    print(f"Manifest written to: {MANIFEST_FILE}")

    if success_count < len(MODELS):
        print("\n⚠ Some models failed to download. Check URLs and network connectivity.")
        print("  The system will fall back to DEV_FALLBACK heuristic adapters for missing models.")


if __name__ == "__main__":
    main()
