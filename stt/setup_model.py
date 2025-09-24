#!/usr/bin/env python3
"""
Setup script for Kyutai STT
Installs dependencies and downloads the required STT model files.
"""

import sys
import subprocess
from pathlib import Path
from huggingface_hub import hf_hub_download

# Configuration
HF_REPO = "kyutai/stt-1b-en_fr"
CHECKPOINT_DIR = Path("checkpoints/stt-1b-en_fr")
FILES_TO_DOWNLOAD = [
    "config.json",
    "model.safetensors",
    "mimi-pytorch-e351c8d8@125.safetensors",
    "tokenizer_en_fr_audio_8000.model"
]

def install_dependencies():
    print("Installing PyTorch (CPU-only)...")
    subprocess.check_call([
        sys.executable, "-m", "pip", "install",
        "torch", "torchvision", "torchaudio",
        "--index-url", "https://download.pytorch.org/whl/cpu"
    ])

    print("Installing other dependencies...")
    deps = ["huggingface_hub", "soundfile"]
    for dep in deps:
        subprocess.check_call([sys.executable, "-m", "pip", "install", dep])

def download_model():
    print(f"Downloading model from {HF_REPO} to {CHECKPOINT_DIR}...")
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

    for filename in FILES_TO_DOWNLOAD:
        try:
            path = hf_hub_download(
                repo_id=HF_REPO,
                filename=filename,
                local_dir=str(CHECKPOINT_DIR),
                local_dir_use_symlinks=False
            )
            print(f"Downloaded {filename} -> {path}")
        except Exception as e:
            print(f"Failed to download {filename}: {e}")

if __name__ == "__main__":
    install_dependencies()
    download_model()
    print("Setup complete! You can now run your STT engine.")