// Ajustes locais em nós de terceiros que não rodam como vêm no ComfyUI testado
// (0.43.0, python 3.12, torch 2.14 cu126, torchvision 0.29, torchaudio 2.11).
// Cada edição troca um trecho exato do arquivo no commit travado em NODE_PACKS. O Trama
// aplica depois do clone e confere nos nós já instalados: se o trecho original não estiver
// lá (arquivo mudado à mão ou outra versão), não mexe e avisa.
//
// Guardamos só os trechos trocados, não cópias dos arquivos do nó.

const NL = '\n';
const lines = (...l) => l.join(NL);

export const PATCHES = {
  'ComfyUI-LatentSyncWrapper': [
    {
      // Sem insightface (não há pacote para Python 3.12 no Windows): usa o detector buffalo_l do ReActor.
      file: 'latentsync/utils/face_detector.py',
      edits: [
        {
          find: lines(
            'from insightface.app import FaceAnalysis',
            'import numpy as np',
            'import torch',
            '',
            'INSIGHTFACE_DETECT_SIZE = 512',
            '',
            '',
            'class FaceDetector:',
            '    def __init__(self, device="cuda"):',
            '        self.app = FaceAnalysis(',
            '            allowed_modules=["detection", "landmark_2d_106"],',
            '            root="checkpoints/auxiliary",',
            '            providers=["CUDAExecutionProvider"],',
            '        )',
          ),
          replace: lines(
            'import os',
            'import sys',
            '',
            'import numpy as np',
            'import torch',
            '',
            'INSIGHTFACE_DETECT_SIZE = 512',
            '',
            '',
            'def _face_analysis():',
            '    """Trama: o insightface não tem pacote para Python 3.12 no Windows. Usa o núcleo do',
            '    ComfyUI-ReActor (mesmos modelos buffalo_l: det_10g + 2d106det, em models/insightface)."""',
            '    try:',
            '        from insightface.app import FaceAnalysis',
            '',
            '        app = FaceAnalysis(allowed_modules=["detection", "landmark_2d_106"], root="checkpoints/auxiliary",',
            '                           providers=["CUDAExecutionProvider"])',
            '        return app',
            '    except ImportError:',
            '        pass',
            '    import folder_paths',
            '',
            '    reactor = os.path.join(os.path.dirname(os.path.abspath(folder_paths.__file__)), "custom_nodes", "ComfyUI-ReActor")',
            '    if not os.path.isdir(reactor):',
            '        raise RuntimeError("O LatentSync precisa do insightface ou do nó ComfyUI-ReActor (detector de rosto buffalo_l).")',
            '    if reactor not in sys.path:',
            '        sys.path.insert(0, reactor)',
            '    from reactor_core.analyzer import ReActorFaceAnalysis',
            '',
            '    return ReActorFaceAnalysis(name="buffalo_l", root=os.path.join(folder_paths.models_dir, "insightface"),',
            '                               providers=["CUDAExecutionProvider", "CPUExecutionProvider"])',
            '',
            '',
            'class FaceDetector:',
            '    def __init__(self, device="cuda"):',
            '        self.app = _face_analysis()',
          ),
        },
      ],
    },
    {
      file: 'nodes.py',
      edits: [
        {
          // torchvision 0.29 não tem mais io.write_video/io.read_video: grava e lê com o PyAV.
          find: 'class LatentSyncNode:',
          replace: lines(
            'def _trama_write_video(path, frames_uint8, fps):',
            '    """Grava quadros [N, H, W, 3] uint8 em MP4 h264 com o PyAV (sem torchvision.io)."""',
            '    import av',
            '    arr = frames_uint8.numpy() if hasattr(frames_uint8, "numpy") else frames_uint8',
            '    h, w = arr.shape[1], arr.shape[2]',
            '    with av.open(path, mode="w") as container:',
            '        stream = container.add_stream("libx264", rate=int(fps))',
            '        stream.width, stream.height = w - w % 2, h - h % 2',
            '        stream.pix_fmt = "yuv420p"',
            '        stream.options = {"crf": "13"}',
            '        for f in arr:',
            '            frame = av.VideoFrame.from_ndarray(f[: stream.height, : stream.width], format="rgb24")',
            '            for packet in stream.encode(frame):',
            '                container.mux(packet)',
            '        for packet in stream.encode():',
            '            container.mux(packet)',
            '',
            '',
            'def _trama_read_video(path):',
            '    """Lê um vídeo como tensor [N, H, W, 3] uint8 com o PyAV (sem torchvision.io)."""',
            '    import av',
            '    import numpy as np',
            '    with av.open(path) as container:',
            '        frames = [f.to_ndarray(format="rgb24") for f in container.decode(video=0)]',
            '    return torch.from_numpy(np.stack(frames))',
            '',
            '',
            'class LatentSyncNode:',
          ),
        },
        {
          // torchaudio 2.11 só grava com o torchcodec; o soundfile já vem com o ComfyUI.
          find: '            torchaudio.save(audio_path, waveform_cpu, sample_rate)',
          replace: lines(
            '            # Trama: o torchaudio novo só grava com o torchcodec; o soundfile já vem no ComfyUI.',
            '            import soundfile as sf',
            '            sf.write(audio_path, waveform_cpu.float().numpy().T, int(sample_rate), subtype="PCM_16")',
          ),
        },
        {
          find: lines(
            '                import torchvision.io as io',
            "                io.write_video(temp_video_path, frames_cpu, fps=25, video_codec='h264')",
          ),
          replace: lines(
            '                # Trama: o torchvision 0.29 não tem mais write_video/read_video; grava com o PyAV.',
            '                _trama_write_video(temp_video_path, frames_cpu, 25)',
          ),
        },
        {
          find: "processed_frames = io.read_video(output_video_path, pts_unit='sec')[0]",
          replace: 'processed_frames = _trama_read_video(output_video_path)',
        },
      ],
    },
  ],
};

const count = (text, part) => text.split(part).length - 1;

/**
 * Aplica as edições num texto. Puro.
 * @returns {{ text: string, state: 'patched'|'applied'|'mismatch', problem?: string }}
 *   patched = já estava ajustado; applied = ajustado agora; mismatch = trecho original não encontrado.
 */
export function applyEdits(original, edits) {
  const crlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  let changed = false;
  for (const e of edits) {
    if (text.includes(e.replace)) continue;
    if (count(text, e.find) !== 1) {
      return { text: original, state: 'mismatch', problem: `trecho não encontrado: ${e.find.split('\n')[0].trim()}` };
    }
    text = text.replace(e.find, () => e.replace);
    changed = true;
  }
  if (!changed) return { text: original, state: 'patched' };
  return { text: crlf ? text.replace(/\n/g, '\r\n') : text, state: 'applied' };
}

/** As edições já estão todas no texto? */
export const isPatched = (text, edits) => {
  const t = text.replace(/\r\n/g, '\n');
  return edits.every((e) => t.includes(e.replace));
};
