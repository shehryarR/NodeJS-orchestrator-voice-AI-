import torch
import numpy as np
import julius
import moshi.models
from pathlib import Path
import struct
import sys

DEVICE = "cpu"

CHECKPOINT_DIR = Path("./checkpoints/stt-1b-en_fr").resolve()
moshi_weight = str(CHECKPOINT_DIR / "model.safetensors")
mimi_weight = str(CHECKPOINT_DIR / "mimi-pytorch-e351c8d8@125.safetensors")
tokenizer_path = str(CHECKPOINT_DIR / "tokenizer_en_fr_audio_8000.model")
config_path = str(CHECKPOINT_DIR / "config.json")

# Load checkpoint
info = moshi.models.loaders.CheckpointInfo.from_hf_repo(
    str(CHECKPOINT_DIR),
    moshi_weights=moshi_weight,
    mimi_weights=mimi_weight,
    tokenizer=tokenizer_path,
    config_path=config_path,
)

mimi = info.get_mimi(device=DEVICE)
tokenizer = info.get_text_tokenizer()
lm = info.get_moshi(device=DEVICE, dtype=torch.float32)  # float32 is safer on CPU
lm_gen = moshi.models.LMGen(lm, temp=0, temp_text=0.0)

# Open streaming session
mimi_stream = mimi.streaming(1).__enter__()
lm_stream = lm_gen.streaming(1).__enter__()

def process_chunk(audio_chunk: np.ndarray):
    """
    Process a single audio chunk (Float32 numpy array).
    Returns partial transcription.
    """
    # make array writable and add batch/channel dims
    audio_tensor = torch.from_numpy(audio_chunk.copy()).unsqueeze(0).unsqueeze(0).to(DEVICE)

    # resample
    audio_tensor = julius.resample_frac(audio_tensor, 24000, mimi.sample_rate)

    # pad to multiple of frame_size
    if audio_tensor.shape[-1] % mimi.frame_size != 0:
        pad_len = mimi.frame_size - audio_tensor.shape[-1] % mimi.frame_size
        audio_tensor = torch.nn.functional.pad(audio_tensor, (0, pad_len))

    # split into frames
    chunks = torch.split(audio_tensor, mimi.frame_size, dim=-1)
    output_text = ""
    for chunk in chunks:
        audio_tokens = mimi.encode(chunk)
        text_tokens = lm_gen.step(audio_tokens)
        text_token = text_tokens[0,0,0].cpu().item()
        if text_token not in (0,3):
            output_text += tokenizer.id_to_piece(text_token).replace("▁"," ")
    return output_text


def read_chunk():
    # Read 4-byte length prefix
    length_bytes = sys.stdin.buffer.read(4)
    if len(length_bytes) < 4:
        return None
    chunk_len = struct.unpack('<I', length_bytes)[0]
    data_bytes = sys.stdin.buffer.read(chunk_len)
    if len(data_bytes) < chunk_len:
        return None
    audio_chunk = np.frombuffer(data_bytes, dtype=np.float32)
    return audio_chunk

if __name__ == "__main__":
    while True:
        chunk = read_chunk()
        if chunk is None:
            break
        text = process_chunk(chunk)
        print(text, flush=True)
