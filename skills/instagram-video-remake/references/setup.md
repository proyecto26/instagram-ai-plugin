# Setup: ComfyUI, the node pack and the models

`doctor` reports exactly what is missing. Nothing here is installed by the skill: tell the user
what is needed, how large it is and where it comes from, and install only after they agree.

## Hardware and software

- A GPU with plenty of memory: the kept runs used 32 GB, and less is untested. Windows or Linux.
- ComfyUI 0.41.0 or newer (it ships the MiniMax H3, SAM 3.1 and video nodes), running on this
  computer. The skill talks to `http://127.0.0.1:8188` unless `--comfy-url` or
  `COMFY_LOCAL_URL` says otherwise, and refuses a non-local address without
  `--allow-remote-comfy`: the files sent are someone's likeness. Redirects are refused.
- ffmpeg with ffprobe on PATH (libx264 and AAC encoders).

## The node pack (one, GPL-3.0, not bundled)

The character-swap graph uses the `h3_character_swap` nodes from
[akatz-labs/h3-character-swap-tool](https://github.com/akatz-labs/h3-character-swap-tool)
(folder `worker_nodes/h3_character_swap`). It is GPL-3.0 and is therefore NOT part of this skill:
the user installs it into their own ComfyUI.

```sh
git clone --filter=blob:none --no-checkout https://github.com/akatz-labs/h3-character-swap-tool.git h3-tool
git -C h3-tool sparse-checkout set worker_nodes/h3_character_swap
git -C h3-tool checkout 0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b
cp -R h3-tool/worker_nodes/h3_character_swap <ComfyUI>/custom_nodes/
```

Use the pack unmodified (this skill sends the resolution as a string, which is what the
unmodified pack expects). Read the code before installing, as with any custom node, then restart
ComfyUI. `doctor` then reports "nodes: all present".

## The seven model files (about 45 GB)

| File | Folder under `models/` | Source | Licence |
|---|---|---|---|
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | MiniMax H3 Community License |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | Comfy-Org/MiniMax-H3 | MiniMax H3 Community License |
| `minimax_h3_video_vae_fp16.safetensors` | `vae/` | Comfy-Org/MiniMax-H3 | MiniMax H3 Community License |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | Comfy-Org/MiniMax-H3 | MiniMax H3 Community License |
| `sam3.1_multiplex_fp16.safetensors` | `checkpoints/` | [Comfy-Org/sam3.1](https://huggingface.co/Comfy-Org/sam3.1) | SAM License |
| `h3_character_swap_v1.5.safetensors` | `loras/` | [akatz-ai/MiniMax-H3-Character-Swap-LoRA](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA) | MiniMax H3 Community License |
| `minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | `loras/` | [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) | Apache-2.0 |

**Licence check, before downloading.** The MiniMax H3 Community License's standard grant excludes
some regions (among them the US, the EU, the UK and South Korea) and restricts some uses. Ask the
user where they are and have them read the licence on the model card; do not decide for them.
Some repositories need an access request and `hf auth login`.

From the ComfyUI root (the folder that contains `models/`):

```sh
hf download Comfy-Org/MiniMax-H3 diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors --local-dir models
hf download Comfy-Org/MiniMax-H3 text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors --local-dir models
hf download Comfy-Org/MiniMax-H3 vae/minimax_h3_video_vae_fp16.safetensors --local-dir models
hf download Comfy-Org/MiniMax-H3 vae/minimax_h3_audio_vae_fp32.safetensors --local-dir models
hf download Comfy-Org/sam3.1 checkpoints/sam3.1_multiplex_fp16.safetensors --local-dir models
hf download akatz-ai/MiniMax-H3-Character-Swap-LoRA h3_character_swap_v1.5.safetensors --local-dir models/loras
hf download lightx2v/Minimax-h3-Turbo minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors --local-dir models/loras
```

Do not commit weights anywhere. Restart ComfyUI (or refresh its model lists) and run `doctor`.

## What the skill leaves on the ComfyUI side

`doctor` checks that every node class of both graphs exists and that each model file name is
offered by a loader; it cannot check a file's contents or version.

Each run uploads its inputs into ComfyUI's `input/` folder (names start with `remake_`: the
stretch of video, the identity photo and, for a continuation, the previous shot and a still)
and ComfyUI writes its result under `output/video/`. The skill copies the result into the run
folder and does not delete anything on the ComfyUI side: tell the user they can remove
`input/remake_*` and `output/video/remake_*` when the remake is finished, since they contain the
identity photo and the video.
