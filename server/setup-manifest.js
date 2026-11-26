// O que cada workflow do Trama precisa no ComfyUI: nós de terceiros (repositório +
// commit), pacotes pip com versão travada e modelos (URL, pasta em ComfyUI/models e
// tamanho em bytes). As Configurações usam isto em "Preparar ComfyUI" para mostrar o
// que falta e instalar; o agente usa a detecção para não oferecer o que não roda.
//
// Testado com o ComfyUI 0.43.0 (python 3.12, torch 2.14 cu126). Os nós que não estão
// em NODE_PACKS vêm do próprio ComfyUI: se faltarem, o ComfyUI precisa de atualização.
// setup.test.js confere este arquivo contra os workflows de comfy-workflows/.

export const TESTED_COMFYUI = '0.43.0';

// Prefixo obrigatório: o Trama nunca copia, troca ou apaga workflow sem ele.
export const WORKFLOW_PREFIX = 'trama_';

const pip = (spec, extra = {}) => ({ spec, ...extra });

/**
 * Nós de terceiros. bundled = vai junto com o Trama (comfy-nodes/). classes = nós que os
 * workflows usam (bastam para saber se o pacote carregou). installScript = roda depois
 * do clone, como o ComfyUI-Manager faz.
 */
export const NODE_PACKS = {
  'ComfyUI-Trama': {
    label: 'ComfyUI-Trama (nós do Trama)',
    bundled: true,
    classes: [
      'TramaMatchVolume', 'TramaMixAudio', 'TramaAudioWindow', 'TramaAceRepaint', 'TramaRepaintSplice', 'TramaLoadMesh',
      'TramaRiggedToGlb', 'TramaContrastBackground', 'TramaLimitMetallic', 'TramaAnimate3D', 'TramaMatchColor', 'TramaMotionToModel', 'TramaVideoMask', 'TramaSpriteSheet',
    ],
    pip: [pip('librosa==1.0.0'), pip('trimesh==5.2.1')],
  },
  'ComfyUI-HY-Motion1': {
    label: 'ComfyUI-HY-Motion1 (movimento por texto)',
    repo: 'https://github.com/jtydhr88/ComfyUI-HY-Motion1',
    ref: '60843a4d631efa3989b5c512ae547f996c30dcc3',
    version: '0.5.1',
    classes: ['HYMotionLoadLLM', 'HYMotionLoadNetwork', 'HYMotionEncodeText', 'HYMotionGenerate', 'HYMotionExportGLB'],
    // Sem o fbxsdkpy do requirements.txt: o FBX sai pelo Blender do UniRig.
    pip: [pip('torchdiffeq==0.2.5'), pip('transforms3d==0.4.2'), pip('omegaconf==2.3.1'), pip('accelerate==1.15.0'), pip('bitsandbytes==0.50.2'), pip('pygltflib==1.16.5')],
  },
  'ComfyUI-UniRig': {
    label: 'ComfyUI-UniRig (esqueleto 3D e Blender)',
    repo: 'https://github.com/PozzettiAndrea/ComfyUI-UniRig',
    ref: '69ee59dc459d2da7cb0291930c1f944886c31d7c',
    version: '1.6.7',
    classes: ['UniRigLoadModel', 'UniRigAutoRig'],
    pip: [pip('comfy-env==0.4.1'), pip('comfy-3d-viewers==0.2.44'), pip('trimesh==5.2.1')],
    // Monta o ambiente isolado do UniRig (torch próprio, Blender/bpy): alguns GB em
    // %LOCALAPPDATA%\Programs\comfy-env, baixados pelo próprio install.py.
    installScript: 'install.py',
    note: 'Depois do clone roda o install.py do UniRig, que monta um ambiente isolado com o Blender (alguns GB fora da pasta do ComfyUI).',
  },
  'ComfyUI_Fill-ChatterBox': {
    label: 'ComfyUI_Fill-ChatterBox (voz a partir de texto)',
    repo: 'https://github.com/filliptm/ComfyUI_Fill-ChatterBox',
    ref: 'f7d7a16187430abcaf91a3039b9c83aa9960816a',
    version: '1.0.5',
    classes: ['FL_ChatterboxMultilingualTTS'],
    // O resto (transformers, diffusers, librosa, omegaconf, soundfile) já vem com o ComfyUI.
    pip: [pip('s3tokenizer==0.3.0'), pip('conformer==0.3.2'), pip('resampy==0.4.3')],
  },
  'ComfyUI-ReActor': {
    label: 'ComfyUI-ReActor (face swap)',
    repo: 'https://github.com/Gourieff/ComfyUI-ReActor',
    ref: '9f2ac3c1a9400366686906af8c2558001c609ef2',
    version: '0.7.2-b3',
    classes: ['ReActorFaceSwap'],
    // O install.py do ReActor atualiza o onnxruntime-gpu para a última versão (CUDA 13),
    // que cai na CPU sem avisar com o torch cu12: por isso não roda, e a versão vai travada.
    pip: [
      pip('onnxruntime-gpu==1.24.4', { exact: true, cuda: '12' }),
      pip('onnx==1.23.2'), pip('albumentations==2.0.8'), pip('segment_anything==1.0'), pip('ultralytics==8.4.215'), pip('colour-science==0.4.7'),
      pip('opencv-python==5.0.0.93', { alt: ['opencv-python-headless', 'opencv-contrib-python', 'opencv-contrib-python-headless'] }),
    ],
  },
  'ComfyUI_Seed-VC': {
    label: 'ComfyUI_Seed-VC (troca de voz)',
    repo: 'https://github.com/billwuhao/ComfyUI_Seed-VC',
    ref: '02c0cb8b05121dd9e391b4287c8e28e0eb4e79a4',
    version: '1.0.1',
    classes: ['SeedVCRun'],
    pip: [
      pip('librosa==1.0.0'), pip('munch==4.0.0'), pip('einops==0.8.2'), pip('pydub==0.25.1'), pip('descript-audio-codec==1.0.0'), pip('soundfile==0.14.0'),
      pip('sounddevice==0.5.6'), pip('funasr==1.4.24'), pip('hydra-core==1.3.8'), pip('pyyaml==6.0.3'), pip('python-dotenv==1.2.2'),
    ],
  },
  'ComfyUI-VideoHelperSuite': {
    label: 'ComfyUI-VideoHelperSuite (carregar vídeo)',
    repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
    ref: '4d907bee61e92c2e65af3bd6383a4e4d356126d1',
    version: '1.7.9',
    classes: ['VHS_LoadVideo'],
    pip: [pip('opencv-python==5.0.0.93', { alt: ['opencv-python-headless', 'opencv-contrib-python', 'opencv-contrib-python-headless'] }), pip('imageio-ffmpeg==0.6.0')],
  },
  'ComfyUI-LatentSyncWrapper': {
    label: 'ComfyUI-LatentSyncWrapper (lip sync)',
    repo: 'https://github.com/ShmuelRonen/ComfyUI-LatentSyncWrapper',
    ref: '360d5283d7276aee68b4237b1387e594e4ce640e',
    version: '1.0.0',
    classes: ['LatentSyncNode', 'VideoLengthAdjuster'],
    // Sem mediapipe e face-alignment do requirements.txt: puxam o opencv-contrib, que briga
    // com o opencv-python. O rosto é detectado com o buffalo_l do ReActor (setup-patches.js).
    pip: [
      pip('decord==0.6.0'), pip('diffusers==0.43.0'), pip('ffmpeg-python==0.2.0'), pip('pytorch-lightning==2.6.6'), pip('DeepCache==0.1.1'),
      pip('omegaconf==2.3.1'), pip('soundfile==0.14.0'), pip('imageio-ffmpeg==0.6.0'),
    ],
    // O nó original não roda neste ComfyUI sem 3 ajustes (torchvision 0.29 sem
    // io.read_video/write_video, torchaudio sem torchcodec, sem insightface no Python 3.12):
    // ficam em setup-patches.js e são aplicados depois do clone. O PyAV (av) vem com o ComfyUI.
    note: 'Depois do clone o Trama aplica 3 ajustes para este ComfyUI (vídeo pelo PyAV, áudio pelo soundfile, rosto pelo detector do ReActor).',
  },
  'ComfyUI-MelBandRoFormer': {
    label: 'ComfyUI-MelBandRoFormer (separa voz e instrumental)',
    repo: 'https://github.com/kijai/ComfyUI-MelBandRoFormer',
    ref: '92c86854e6654f4aacc97484471af95c98ea16d4',
    version: '1.0.2',
    classes: ['MelBandRoFormerModelLoader', 'MelBandRoFormerSampler'],
    pip: [pip('rotary_embedding_torch==0.9.2'), pip('einops==0.8.2')],
  },
};

// Pacotes que o Trama nunca deixa o pip trocar (vão como restrição no pip install).
export const PROTECTED_PACKAGES = ['torch', 'torchvision', 'torchaudio', 'onnxruntime-gpu'];

const HF = 'https://huggingface.co';
const file = (name, url, size) => ({ name, url, size });
const one = (dir, name, url, size, extra = {}) => ({ dir, files: [file(name, url, size)], ...extra });
const repoFiles = (dir, repo, list, extra = {}) => ({ dir, files: list.map(([name, size]) => file(name, `${HF}/${repo}/resolve/main/${name}`, size)), ...extra });

/**
 * Modelos. id = nome do arquivo (o que o workflow cita) ou o nome da pasta.
 * dir = pasta dentro de ComfyUI/models (o nome do folder_paths do ComfyUI quando existe).
 * url null = não há fonte pública conhecida: o usuário põe o arquivo à mão.
 * auto = o próprio nó baixa no primeiro uso; entra só na conta de espaço.
 * root 'custom_nodes' = dir é relativo a ComfyUI/custom_nodes (nó que lê os modelos da própria pasta).
 * source 'imageio-ffmpeg' = o arquivo é o ffmpeg do pacote imageio-ffmpeg, copiado pelo Trama.
 */
export const MODELS = {
  // Imagem
  'z_image_turbo_bf16.safetensors': one('diffusion_models', 'z_image_turbo_bf16.safetensors', `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors`, 12309866400),
  'qwen_3_4b.safetensors': one('text_encoders', 'qwen_3_4b.safetensors', `${HF}/Comfy-Org/flux2-klein/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`, 8044982048),
  'ae.safetensors': one('vae', 'ae.safetensors', `${HF}/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/vae/ae.safetensors`, 335304388),
  'Z-Image-Turbo-Fun-Controlnet-Union.safetensors': one('model_patches', 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors', `${HF}/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union.safetensors`, 3101572408),
  'sdpose_wholebody_fp16.safetensors': one('checkpoints', 'sdpose_wholebody_fp16.safetensors', `${HF}/Comfy-Org/SDPose/resolve/main/checkpoints/sdpose_wholebody_fp16.safetensors`, 1916645792),
  'qwen_image_fp8_e4m3fn.safetensors': one('diffusion_models', 'qwen_image_fp8_e4m3fn.safetensors', `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors`, 20430635136),
  'qwen_2.5_vl_7b_fp8_scaled.safetensors': one('text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', `${HF}/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`, 9384670680),
  'qwen_image_vae.safetensors': one('vae', 'qwen_image_vae.safetensors', `${HF}/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors`, 253806246),
  'flux-2-klein-4b-fp8.safetensors': one('diffusion_models', 'flux-2-klein-4b-fp8.safetensors', `${HF}/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors`, 4070624520),
  'flux2-vae.safetensors': one('vae', 'flux2-vae.safetensors', `${HF}/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors`, 336213556),
  'ernie-image-turbo.safetensors': one('diffusion_models', 'ernie-image-turbo.safetensors', `${HF}/Comfy-Org/ERNIE-Image/resolve/main/diffusion_models/ernie-image-turbo.safetensors`, 16067025480),
  'ministral-3-3b.safetensors': one('text_encoders', 'ministral-3-3b.safetensors', `${HF}/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors`, 7717637511),
  'ernie-image-prompt-enhancer.safetensors': one('text_encoders', 'ernie-image-prompt-enhancer.safetensors', `${HF}/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ernie-image-prompt-enhancer.safetensors`, 6877439999),
  'NewBie-Image-Exp0.1-bf16.safetensors': one('diffusion_models', 'NewBie-Image-Exp0.1-bf16.safetensors', `${HF}/Comfy-Org/NewBie-image-Exp0.1_repackaged/resolve/main/split_files/diffusion_models/NewBie-Image-Exp0.1-bf16.safetensors`, 6973329400),
  'gemma_3_4b_it_bf16.safetensors': one('text_encoders', 'gemma_3_4b_it_bf16.safetensors', `${HF}/Comfy-Org/NewBie-image-Exp0.1_repackaged/resolve/main/split_files/text_encoders/gemma_3_4b_it_bf16.safetensors`, 7765267250),
  'jina_clip_v2_bf16.safetensors': one('text_encoders', 'jina_clip_v2_bf16.safetensors', `${HF}/Comfy-Org/NewBie-image-Exp0.1_repackaged/resolve/main/split_files/text_encoders/jina_clip_v2_bf16.safetensors`, 1121730691),
  // Editar imagem
  'qwen_image_2.1_int8_convrot.safetensors': one('diffusion_models', 'qwen_image_2.1_int8_convrot.safetensors', `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors`, 7256783064),
  'qwen3vl_8b_int8_convrot.safetensors': one('text_encoders', 'qwen3vl_8b_int8_convrot.safetensors', `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors`, 9350798360),
  'qwen_image_2.1_vae_bf16.safetensors': one('vae', 'qwen_image_2.1_vae_bf16.safetensors', `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors`, 675509688),
  'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors': one('text_encoders', 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors', `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors`, 9471072252),
  'qwen_image_edit_2511_int8_convrot.safetensors': one('diffusion_models', 'qwen_image_edit_2511_int8_convrot.safetensors', `${HF}/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors`, 20499083824),
  'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors': one('loras', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', `${HF}/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`, 849608296),
  // Ampliar e remover fundo
  'RealESRGAN_x4plus.pth': one('upscale_models', 'RealESRGAN_x4plus.pth', 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth', 67040989),
  'RealESRGAN_x2plus.pth': one('upscale_models', 'RealESRGAN_x2plus.pth', 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth', 67061725),
  'birefnet.safetensors': one('background_removal', 'birefnet.safetensors', `${HF}/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors`, 444473596),
  // Vídeo: MiniMax H3
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors': one('diffusion_models', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`, 20970379616),
  'minimax_h3_ref2va_pruned_int8_convrot.safetensors': one('diffusion_models', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`, 20970379616),
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': one('text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', `${HF}/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`, 15687142551),
  'minimax_h3_video_vae_fp16.safetensors': one('vae', 'minimax_h3_video_vae_fp16.safetensors', `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors`, 5207808496),
  'minimax_h3_audio_vae_fp32.safetensors': one('vae', 'minimax_h3_audio_vae_fp32.safetensors', `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors`, 605254808),
  'h3_character_swap_pro4500_1000.safetensors': one('loras', 'h3_character_swap_pro4500_1000.safetensors', null, 155110320),
  // Vídeo: LTX-2.3
  'ltx-2.3-22b-dev-fp8.safetensors': one('checkpoints', 'ltx-2.3-22b-dev-fp8.safetensors', `${HF}/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors`, 29145431166),
  'ltx-2.3-22b-distilled-lora-384.safetensors': one('loras', 'ltx-2.3-22b-distilled-lora-384.safetensors', `${HF}/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384.safetensors`, 7605507256),
  'ltx-2.3-spatial-upscaler-x2-1.1.safetensors': one('latent_upscale_models', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', `${HF}/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors`, 995743560),
  'gemma_3_12B_it_fp4_mixed.safetensors': one('text_encoders', 'gemma_3_12B_it_fp4_mixed.safetensors', `${HF}/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors`, 9447702218),
  // Vídeo: Wan 2.2
  'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors': one('diffusion_models', 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors`, 14294742832),
  'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors': one('diffusion_models', 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors`, 14294742832),
  'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors': one('loras', 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`, 1226977424),
  'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors': one('loras', 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`, 1226977424),
  'umt5_xxl_fp8_e4m3fn_scaled.safetensors': one('text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', `${HF}/Comfy-Org/Wan-Animate-2/resolve/main/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`, 6735906897),
  'wan_2.1_vae.safetensors': one('vae', 'wan_2.1_vae.safetensors', `${HF}/Comfy-Org/JoyAI-Image-Edit/resolve/main/vae/wan_2.1_vae.safetensors`, 253815318),
  // Música: ACE-Step 1.5
  'acestep_v1.5_xl_turbo_bf16.safetensors': one('diffusion_models', 'acestep_v1.5_xl_turbo_bf16.safetensors', `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors`, 9974719892),
  'ace_1.5_vae.safetensors': one('vae', 'ace_1.5_vae.safetensors', `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors`, 337431732),
  'qwen_0.6b_ace15.safetensors': one('text_encoders', 'qwen_0.6b_ace15.safetensors', `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors`, 1191588248),
  'qwen_4b_ace15.safetensors': one('text_encoders', 'qwen_4b_ace15.safetensors', `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_4b_ace15.safetensors`, 8379154232),
  'ace_step_1.5_turbo_aio.safetensors': one('checkpoints', 'ace_step_1.5_turbo_aio.safetensors', `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/checkpoints/ace_step_1.5_turbo_aio.safetensors`, 10025478736),
  // Voz: Seed-VC e MelBandRoFormer
  'minimax_music3_dit_fp16.safetensors': one('diffusion_models', 'minimax_music3_dit_fp16.safetensors', `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_fp16.safetensors`, 4914197682),
  'minimax_music3_text_encoder_pruned_int8_convrot.safetensors': one('text_encoders', 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors`, 9196611886),
  'minimax_music3_dav.safetensors': one('vae', 'minimax_music3_dav.safetensors', `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors`, 216696128),
  // O nó lê de models/chatterbox/chatterbox_multilingual (baixa sozinho se faltar, pelo cache do HF).
  'chatterbox_multilingual': repoFiles('chatterbox/chatterbox_multilingual', 'ResembleAI/chatterbox', [
    ['t3_mtl23ls_v2.safetensors', 2143989752], ['s3gen.pt', 1057165844], ['ve.pt', 5698626], ['grapheme_mtl_merged_expanded_v1.json', 69989],
    ['conds.pt', 107374], ['Cangjie5_TC.json', 1920163],
  ]),
  'rife_v4.26.safetensors': one('frame_interpolation', 'rife_v4.26.safetensors', `${HF}/Comfy-Org/Frame-Interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors`, 22674688),
  'MelBandRoformer_fp16.safetensors': one('diffusion_models', 'MelBandRoformer_fp16.safetensors', `${HF}/Kijai/MelBandRoFormer_comfy/resolve/main/MelBandRoformer_fp16.safetensors`, 456479072),
  'Seed-VC': {
    dir: 'TTS/Seed-VC',
    files: [
      file('DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth', `${HF}/Plachta/Seed-VC/resolve/main/DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth`, 440312082),
      file('DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema.pth', `${HF}/Plachta/Seed-VC/resolve/main/DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema.pth`, 820864573),
      file('campplus_cn_common.bin', `${HF}/funasr/campplus/resolve/main/campplus_cn_common.bin`, 28036335),
      file('rmvpe.pt', `${HF}/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt`, 181184272),
    ],
  },
  'bigvgan_v2_22khz_80band_256x': repoFiles('TTS/bigvgan_v2_22khz_80band_256x', 'nvidia/bigvgan_v2_22khz_80band_256x', [['bigvgan_generator.pt', 449228171], ['config.json', 1405]]),
  'bigvgan_v2_44khz_128band_512x': repoFiles('TTS/bigvgan_v2_44khz_128band_512x', 'nvidia/bigvgan_v2_44khz_128band_512x', [['bigvgan_generator.pt', 489041291], ['config.json', 1403]]),
  'whisper-small': repoFiles('TTS/whisper-small', 'openai/whisper-small', [
    ['model.safetensors', 966995080], ['config.json', 1967], ['generation_config.json', 3868], ['added_tokens.json', 34604], ['merges.txt', 493869],
    ['normalizer.json', 52666], ['preprocessor_config.json', 184990], ['special_tokens_map.json', 2194], ['tokenizer.json', 2480466],
    ['tokenizer_config.json', 282683], ['vocab.json', 835550],
  ]),
  // 3D
  'trellis_2_int8_convrot.safetensors': one('diffusion_models', 'trellis_2_int8_convrot.safetensors', `${HF}/Comfy-Org/TRELLIS.2/resolve/main/diffusion_models/trellis_2_int8_convrot.safetensors`, 5253048192),
  'pixal3d_int8_convrot.safetensors': one('diffusion_models', 'pixal3d_int8_convrot.safetensors', `${HF}/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_int8_convrot.safetensors`, 5584555824),
  'trellis_2_shape_vae_bf16.safetensors': one('vae', 'trellis_2_shape_vae_bf16.safetensors', `${HF}/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors`, 1095844024),
  'trellis_2_texture_vae_bf16.safetensors': one('vae', 'trellis_2_texture_vae_bf16.safetensors', `${HF}/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors`, 948461364),
  'dino_v3_L_naf_fp32.safetensors': one('clip_vision', 'dino_v3_L_naf_fp32.safetensors', `${HF}/Comfy-Org/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors`, 1215214176),
  'moge_2_vitl_normal_fp16.safetensors': one('geometry_estimation', 'moge_2_vitl_normal_fp16.safetensors', `${HF}/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors`, 661859924),
  'unirig': repoFiles('unirig', 'apozz/UniRig-safetensors', [['skeleton.safetensors', 1440598432], ['skin.safetensors', 1458123556]]),
  'HY-Motion-1.0': {
    dir: 'HY-Motion/ckpts/tencent/HY-Motion-1.0',
    files: [
      file('config.yml', `${HF}/tencent/HY-Motion-1.0/resolve/main/HY-Motion-1.0/config.yml`, 956),
      file('latest.ckpt', `${HF}/tencent/HY-Motion-1.0/resolve/main/HY-Motion-1.0/latest.ckpt`, 4171703514),
    ],
  },
  'Qwen3-8B-bnb-4bit': repoFiles('HY-Motion/ckpts/Qwen3-8B-bnb-4bit', 'unsloth/Qwen3-8B-bnb-4bit', [
    ['model.safetensors', 6073558089], ['config.json', 1330], ['generation_config.json', 237], ['added_tokens.json', 707], ['chat_template.jinja', 4673],
    ['merges.txt', 1671853], ['special_tokens_map.json', 614], ['tokenizer.json', 11422654], ['tokenizer_config.json', 10534], ['vocab.json', 2776833],
  ]),
  'clip-vit-large-patch14': repoFiles('HY-Motion/ckpts/clip-vit-large-patch14', 'openai/clip-vit-large-patch14', [
    ['model.safetensors', 1710540580], ['config.json', 4519], ['merges.txt', 524619], ['preprocessor_config.json', 316], ['special_tokens_map.json', 389],
    ['tokenizer.json', 2224003], ['tokenizer_config.json', 905], ['vocab.json', 961143],
  ]),
  // Face swap (ReActor)
  'inswapper_128.onnx': one('insightface', 'inswapper_128.onnx', `${HF}/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx`, 554253681),
  'GPEN-BFR-512.onnx': one('facerestore_models', 'GPEN-BFR-512.onnx', `${HF}/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-512.onnx`, 284244491),
  'vit-base-nsfw-detector': repoFiles('nsfw_detector/vit-base-nsfw-detector', 'AdamCodd/vit-base-nsfw-detector', [['model.safetensors', 344391328], ['config.json', 715], ['preprocessor_config.json', 232]]),
  // Lip sync (LatentSync 1.6): o nó lê os modelos de dentro da própria pasta.
  'latentsync_unet.pt': { root: 'custom_nodes', ...one('ComfyUI-LatentSyncWrapper/checkpoints', 'latentsync_unet.pt', `${HF}/ByteDance/LatentSync-1.6/resolve/main/latentsync_unet.pt`, 5072222488) },
  'latentsync-whisper-tiny': { root: 'custom_nodes', ...one('ComfyUI-LatentSyncWrapper/checkpoints/whisper', 'tiny.pt', `${HF}/ByteDance/LatentSync-1.6/resolve/main/whisper/tiny.pt`, 75572083) },
  'sd-vae-ft-mse': { root: 'custom_nodes', ...repoFiles('ComfyUI-LatentSyncWrapper/checkpoints/vae', 'stabilityai/sd-vae-ft-mse', [['diffusion_pytorch_model.safetensors', 334643276], ['config.json', 547]]) },
  // O nó procura o ffmpeg.exe na pasta dele: o Trama copia o do pacote imageio-ffmpeg.
  'latentsync-ffmpeg': { root: 'custom_nodes', source: 'imageio-ffmpeg', ...one('ComfyUI-LatentSyncWrapper/ffmpeg/bin', 'ffmpeg.exe', null, 87638016) },
  'buffalo_l': {
    dir: 'insightface/models/buffalo_l',
    auto: true,
    files: [file('det_10g.onnx', null, 16923827), file('w600k_r50.onnx', null, 174383860), file('1k3d68.onnx', null, 143607619), file('2d106det.onnx', null, 5030888), file('genderage.onnx', null, 1322532)],
  },
  'facedetection': {
    dir: 'facedetection',
    auto: true,
    files: [file('detection_Resnet50_Final.pth', null, 109497761), file('parsing_parsenet.pth', null, 85331193)],
  },
};

/**
 * O que cada workflow empacotado precisa. packs: chaves de NODE_PACKS. models: chaves de MODELS.
 * label/category: como aparece em "Preparar ComfyUI" (categoria das Configurações ou
 * "internal" para os que o Trama usa por baixo: IA local de texto e troca de personagem).
 */
export const WORKFLOWS = {
  'trama_imagem_z_image_turbo.json': { packs: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors'] },
  // Imagem com controle: a referência vira estrutura (pose, contorno ou profundidade) pelo ControlNet Union do Z-Image.
  'trama_imagem_pose_z_image.json': { packs: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors', 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors', 'sdpose_wholebody_fp16.safetensors'] },
  'trama_imagem_contorno_z_image.json': { packs: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors', 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors'] },
  'trama_imagem_profundidade_z_image.json': { packs: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors', 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors', 'moge_2_vitl_normal_fp16.safetensors'] },
  'trama_imagem_pintar_regiao.json': { packs: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors'] },
  'trama_imagem_expandir.json': { packs: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors'] },
  'trama_imagem_qwen_image.json': { packs: [], models: ['qwen_image_fp8_e4m3fn.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen_image_vae.safetensors'] },
  'trama_imagem_flux2_klein.json': { packs: [], models: ['flux-2-klein-4b-fp8.safetensors', 'qwen_3_4b.safetensors', 'flux2-vae.safetensors'] },
  'trama_imagem_ernie_turbo.json': { packs: [], models: ['ernie-image-turbo.safetensors', 'ministral-3-3b.safetensors', 'ernie-image-prompt-enhancer.safetensors', 'flux2-vae.safetensors'] },
  'trama_imagem_newbie.json': { packs: [], models: ['NewBie-Image-Exp0.1-bf16.safetensors', 'gemma_3_4b_it_bf16.safetensors', 'jina_clip_v2_bf16.safetensors', 'ae.safetensors'] },
  'trama_editar_imagem_qwen_2_1.json': { packs: [], models: ['qwen_image_2.1_int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors', 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'] },
  'trama_editar_imagem_qwen_2_1_referencia.json': { packs: [], models: ['qwen_image_2.1_int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors', 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'] },
  'trama_editar_imagem_qwen_2511.json': { packs: [], models: ['qwen_image_edit_2511_int8_convrot.safetensors', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen_image_vae.safetensors'] },
  'trama_editar_imagem_flux2_klein.json': { packs: [], models: ['flux-2-klein-4b-fp8.safetensors', 'qwen_3_4b.safetensors', 'flux2-vae.safetensors'] },
  'trama_ampliar_imagem.json': { packs: [], models: ['RealESRGAN_x4plus.pth'] },
  'trama_remover_fundo.json': { packs: [], models: ['birefnet.safetensors'] },
  'trama_video_remover_fundo.json': { packs: ['ComfyUI-Trama'], models: ['birefnet.safetensors'] },
  'trama_video_trocar_fundo.json': { packs: ['ComfyUI-Trama'], models: ['birefnet.safetensors'] },
  // Sprite sheet: vídeo do personagem → máscara (BiRefNet) → ciclo do movimento → folha, GIF e pixel art (TramaSpriteSheet).
  'trama_sprite_video.json': { packs: ['ComfyUI-Trama'], models: ['birefnet.safetensors'] },
  'trama_video_h3_texto.json': { packs: [], models: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors', 'RealESRGAN_x2plus.pth'] },
  'trama_video_h3_imagem.json': { packs: [], models: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors', 'RealESRGAN_x2plus.pth'] },
  'trama_h3_primeiro_ultimo_quadro.json': { packs: [], models: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors', 'RealESRGAN_x2plus.pth'] },
  'trama_video_h3_referencia.json': { packs: [], models: ['minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors', 'RealESRGAN_x2plus.pth'] },
  'trama_video_ltx23_texto.json': { packs: [], models: ['ltx-2.3-22b-dev-fp8.safetensors', 'ltx-2.3-22b-distilled-lora-384.safetensors', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', 'gemma_3_12B_it_fp4_mixed.safetensors'] },
  'trama_video_ltx23_imagem.json': { packs: [], models: ['ltx-2.3-22b-dev-fp8.safetensors', 'ltx-2.3-22b-distilled-lora-384.safetensors', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', 'gemma_3_12B_it_fp4_mixed.safetensors'] },
  'trama_foto_falando.json': { packs: [], models: ['ltx-2.3-22b-dev-fp8.safetensors', 'ltx-2.3-22b-distilled-lora-384.safetensors', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', 'gemma_3_12B_it_fp4_mixed.safetensors'] },
  'trama_video_wan22_imagem.json': { packs: [], models: ['wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors'] },
  'trama_video_wan22_quadros.json': { packs: [], models: ['wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors'] },
  'trama_interpolar_quadros.json': { packs: [], models: ['rife_v4.26.safetensors'] },
  'trama_ampliar_video.json': { packs: [], models: ['RealESRGAN_x4plus.pth'] },
  'trama_ampliar_video_ltx23.json': { packs: [], models: ['RealESRGAN_x2plus.pth', 'ltx-2.3-22b-dev-fp8.safetensors', 'ltx-2.3-22b-distilled-lora-384.safetensors', 'gemma_3_12B_it_fp4_mixed.safetensors'] },
  'trama_trocar_personagem_video.json': { packs: [], category: 'internal', label: 'MiniMax H3 (trocar personagem no vídeo)', models: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'h3_character_swap_pro4500_1000.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors', 'RealESRGAN_x2plus.pth'] },
  'trama_face_swap_foto.json': { packs: ['ComfyUI-ReActor'], models: ['inswapper_128.onnx', 'GPEN-BFR-512.onnx', 'vit-base-nsfw-detector', 'buffalo_l', 'facedetection'] },
  'trama_face_swap_video.json': { packs: ['ComfyUI-ReActor'], models: ['inswapper_128.onnx', 'GPEN-BFR-512.onnx', 'vit-base-nsfw-detector', 'buffalo_l', 'facedetection'] },
  // O detector de rosto é o buffalo_l do ReActor (o ReActor baixa no primeiro uso).
  'trama_lip_sync_video.json': { packs: ['ComfyUI-LatentSyncWrapper', 'ComfyUI-ReActor', 'ComfyUI-VideoHelperSuite'], models: ['latentsync_unet.pt', 'latentsync-whisper-tiny', 'sd-vae-ft-mse', 'latentsync-ffmpeg', 'buffalo_l'] },
  'trama_musica_com_voz_ace_step.json': { packs: [], models: ['acestep_v1.5_xl_turbo_bf16.safetensors', 'ace_1.5_vae.safetensors', 'qwen_0.6b_ace15.safetensors', 'qwen_4b_ace15.safetensors'] },
  'trama_musica_minimax_music3.json': { packs: [], models: ['minimax_music3_dit_fp16.safetensors', 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', 'minimax_music3_dav.safetensors'] },
  'trama_musica_ace_step_aio.json': { packs: [], models: ['ace_step_1.5_turbo_aio.safetensors'] },
  'trama_editar_trecho_musica.json': { packs: ['ComfyUI-Trama'], models: ['acestep_v1.5_xl_turbo_bf16.safetensors', 'ace_1.5_vae.safetensors', 'qwen_0.6b_ace15.safetensors', 'qwen_4b_ace15.safetensors'] },
  'trama_separar_voz.json': { packs: ['ComfyUI-MelBandRoFormer'], models: ['MelBandRoformer_fp16.safetensors'] },
  'trama_voz_texto.json': { packs: ['ComfyUI_Fill-ChatterBox'], models: ['chatterbox_multilingual'] },
  'trama_voz_texto_clonada.json': { packs: ['ComfyUI_Fill-ChatterBox'], models: ['chatterbox_multilingual'] },
  'trama_trocar_voz.json': { packs: ['ComfyUI_Seed-VC'], models: ['Seed-VC', 'bigvgan_v2_22khz_80band_256x', 'bigvgan_v2_44khz_128band_512x', 'whisper-small'] },
  'trama_trocar_voz_musica.json': { packs: ['ComfyUI_Seed-VC', 'ComfyUI-MelBandRoFormer', 'ComfyUI-Trama'], models: ['MelBandRoformer_fp16.safetensors', 'Seed-VC', 'bigvgan_v2_22khz_80band_256x', 'bigvgan_v2_44khz_128band_512x', 'whisper-small'] },
  'trama_3d_trellis2.json': { packs: ['ComfyUI-Trama'], models: ['trellis_2_int8_convrot.safetensors', 'trellis_2_shape_vae_bf16.safetensors', 'trellis_2_texture_vae_bf16.safetensors', 'dino_v3_L_naf_fp32.safetensors', 'birefnet.safetensors'] },
  'trama_3d_pixal3d.json': { packs: [], models: ['pixal3d_int8_convrot.safetensors', 'trellis_2_shape_vae_bf16.safetensors', 'trellis_2_texture_vae_bf16.safetensors', 'dino_v3_L_naf_fp32.safetensors', 'moge_2_vitl_normal_fp16.safetensors', 'birefnet.safetensors'] },
  // O rig e as duas animações usam o Blender do ambiente do UniRig (TramaRiggedToGlb, FBX).
  'trama_3d_rig.json': { packs: ['ComfyUI-Trama', 'ComfyUI-UniRig'], models: ['unirig'] },
  'trama_3d_animar.json': { packs: ['ComfyUI-Trama', 'ComfyUI-UniRig'], models: [] },
  'trama_3d_movimento.json': { packs: ['ComfyUI-Trama', 'ComfyUI-UniRig', 'ComfyUI-HY-Motion1'], models: ['HY-Motion-1.0', 'Qwen3-8B-bnb-4bit', 'clip-vit-large-patch14'] },
  'trama_texto_ia_local.json': { packs: [], category: 'internal', label: 'IA local de texto (agente sem internet)', models: ['qwen3vl_8b_int8_convrot.safetensors'] },
};

/** Tamanho total de um modelo (soma dos arquivos). */
export const modelSize = (id) => (MODELS[id]?.files || []).reduce((s, f) => s + (f.size || 0), 0);

/** Pacotes pip de um conjunto de nós, sem repetir (o primeiro que aparece vale). */
export function pipOf(packIds) {
  const seen = new Map();
  for (const id of packIds) for (const p of NODE_PACKS[id]?.pip || []) {
    const name = pipName(p.spec);
    if (!seen.has(name)) seen.set(name, p);
  }
  return [...seen.values()];
}

/** "onnxruntime-gpu==1.24.4" -> "onnxruntime-gpu" (normalizado como o pip compara). */
export const pipName = (spec) => spec.split(/[=<>!~ ]/)[0].trim().toLowerCase().replace(/[_.]+/g, '-');
export const pipVersion = (spec) => (spec.match(/==\s*([^\s;]+)/) || [])[1] || null;

/** Qual pacote de nós fornece uma classe (ou null = nó do próprio ComfyUI). */
export function packOfClass(classType) {
  return Object.keys(NODE_PACKS).find((id) => NODE_PACKS[id].classes.includes(classType)) || null;
}
