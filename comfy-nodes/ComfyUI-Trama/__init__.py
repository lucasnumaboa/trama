"""Nós do Trama para o ComfyUI.

TramaMatchVolume: deixa um áudio no mesmo volume de outro. Usado na troca da voz
cantada: o Seed-VC devolve a voz nova num volume que muda de música para música
(às vezes 10 dB acima, às vezes 12 dB abaixo da voz original), então um ajuste fixo
não serve. O nó mede o volume dos trechos com som de cada um (ignora silêncios) e
aplica o ganho que falta, com um ajuste opcional em dB por cima.
"""

import math

import torch


def _active_db(waveform, sample_rate, window_s=0.4, floor=0.05):
    """Volume (dBFS) só dos trechos com som: janelas de 0,4 s acima de 5% do pico de RMS."""
    mono = waveform.float().mean(dim=tuple(range(waveform.dim() - 1)))  # [T]
    w = max(1, int(sample_rate * window_s))
    n = mono.shape[-1] // w
    if n == 0:
        rms = mono.pow(2).mean().sqrt()
        return 20 * math.log10(float(rms) + 1e-9)
    frames = mono[: n * w].reshape(n, w)
    rms = frames.pow(2).mean(dim=1).sqrt()
    active = rms[rms > rms.max() * floor]
    power = active.pow(2).mean() if active.numel() else rms.pow(2).mean()
    return 10 * math.log10(float(power) + 1e-12)


class TramaMatchVolume:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "Áudio a ajustar (ex.: a voz nova do Seed-VC)."}),
                "reference": ("AUDIO", {"tooltip": "Áudio com o volume desejado (ex.: a voz original separada)."}),
                "offset_db": ("FLOAT", {"default": 0.0, "min": -24.0, "max": 24.0, "step": 0.5,
                                        "tooltip": "Ajuste por cima do volume igualado: +3 deixa 3 dB mais alto, -3 mais baixo."}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "match"
    CATEGORY = "audio/trama"
    DESCRIPTION = "Iguala o volume de um áudio ao de outro (trechos com som), com ajuste opcional em dB."

    def match(self, audio, reference, offset_db):
        wave = audio["waveform"]
        target = _active_db(reference["waveform"], reference["sample_rate"])
        current = _active_db(wave, audio["sample_rate"])
        gain_db = max(-30.0, min(30.0, target - current + float(offset_db)))
        out = wave.float() * (10 ** (gain_db / 20))
        # Sem estourar: se o pico passar de 0 dBFS, abaixa só o necessário.
        peak = float(out.abs().max()) if out.numel() else 0.0
        if peak > 0.999:
            out = out * (0.999 / peak)
        print(f"[TramaMatchVolume] voz {current:.1f} dB -> {target + float(offset_db):.1f} dB (ganho {gain_db:+.1f} dB)")
        return ({"waveform": out.to(wave.dtype), "sample_rate": audio["sample_rate"]},)


def _soft_limit(x, knee=0.89):
    """Limitador suave: deixa o sinal como está até ~-1 dBFS e arredonda só os picos acima,
    sem baixar a música inteira (o AudioMerge divide tudo pelo maior pico)."""
    a = x.abs()
    over = a > knee
    if not bool(over.any()):
        return x
    room = 1.0 - knee
    limited = knee + room * torch.tanh((a - knee) / room)
    return torch.where(over, torch.sign(x) * limited, x)


class TramaMixAudio:
    """Junta voz e instrumental (soma) na duração do instrumental, com limitador suave
    no lugar da normalização pelo pico do AudioMerge, para manter o volume da música."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"base": ("AUDIO", {"tooltip": "Instrumental: define a duração e a taxa."}),
                             "overlay": ("AUDIO", {"tooltip": "Voz a somar por cima."})}}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "mix"
    CATEGORY = "audio/trama"
    DESCRIPTION = "Soma dois áudios na duração do primeiro, com limitador suave (sem baixar o volume da música)."

    def mix(self, base, overlay):
        import comfy.audio

        a, sr = base["waveform"].float(), base["sample_rate"]
        b = overlay["waveform"].float()
        if overlay["sample_rate"] != sr:
            b = comfy.audio.resample(b, overlay["sample_rate"], sr)
        if b.shape[1] != a.shape[1]:
            b = b.mean(dim=1, keepdim=True).expand(-1, a.shape[1], -1)
        n = a.shape[-1]
        b = b[..., :n] if b.shape[-1] >= n else torch.nn.functional.pad(b, (0, n - b.shape[-1]))
        out = _soft_limit(a + b.to(a.device))
        return ({"waveform": out.to(base["waveform"].dtype), "sample_rate": sr},)


_WHISPER = {}


def _whisper_pipeline(device):
    """Whisper small (o mesmo que o Seed-VC usa, em models/TTS/whisper-small)."""
    import os
    import folder_paths
    from transformers import pipeline

    key = str(device)
    if key not in _WHISPER:
        path = os.path.join(folder_paths.models_dir, "TTS", "whisper-small")
        if not os.path.isdir(path):
            raise FileNotFoundError(f"falta o Whisper em {path} (vem com os modelos do Seed-VC)")
        _WHISPER.clear()
        _WHISPER[key] = pipeline("automatic-speech-recognition", model=path, device=device,
                                 torch_dtype=torch.float16 if "cuda" in key else torch.float32)
    return _WHISPER[key]


class TramaTranscribeAudio:
    """Transcreve a voz com os tempos de cada frase (Whisper small). Serve para achar onde
    uma frase é cantada antes de trocar a letra de um trecho, ou para saber o que é dito."""

    LANGUAGES = ["auto", "portuguese", "english", "spanish", "japanese", "french", "italian", "german", "korean", "chinese"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "De preferência só a voz (saída vocals do separador)."}),
                "language": (cls.LANGUAGES, {"default": "auto"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("transcript",)
    FUNCTION = "transcribe"
    OUTPUT_NODE = True
    CATEGORY = "audio/trama"
    DESCRIPTION = "Texto da voz com início e fim de cada frase, em JSON (Whisper small)."

    def transcribe(self, audio, language):
        import json
        import torchaudio
        try:
            import comfy.model_management as mm
            device = mm.get_torch_device()
        except Exception:
            device = "cpu"
        wave = audio["waveform"].float().mean(dim=tuple(range(audio["waveform"].dim() - 1)))
        if audio["sample_rate"] != 16000:
            wave = torchaudio.functional.resample(wave, audio["sample_rate"], 16000)
        asr = _whisper_pipeline(device)
        kwargs = {"task": "transcribe", "no_repeat_ngram_size": 6}
        if language != "auto":
            kwargs["language"] = language
        # O Whisper em música repete uma frase sem parar e não dá os tempos de cada uma.
        # Então a voz é cortada nas pausas (a voz separada tem silêncios claros) e cada
        # pedaço é transcrito sozinho, com limite de palavras; os tempos vêm do corte.
        pieces = _voice_pieces(wave.cpu().numpy(), 16000)
        segments = []
        if pieces:
            inputs = [{"raw": wave[a:b].cpu().numpy(), "sampling_rate": 16000} for a, b in pieces]
            outs = asr(inputs, batch_size=8, generate_kwargs={**kwargs, "max_new_tokens": 96})
            for (a, b), o in zip(pieces, outs):
                text = (o.get("text") or "").strip()
                if text:
                    segments.append({"start": round(a / 16000, 2), "end": round(b / 16000, 2), "text": text})
        report = json.dumps({"text": " ".join(s["text"] for s in segments), "segments": segments}, ensure_ascii=False)
        print(f"[TramaTranscribeAudio] {len(segments)} trechos")
        return {"ui": {"text": [report]}, "result": (report,)}


def _voice_pieces(y, sr, min_gap=0.35, max_len=18.0, min_len=0.6):
    """Corta a voz em pedaços nas pausas: janelas de 20 ms abaixo de 6% do pico são
    silêncio; pausas de 0,35 s separam frases; pedaços longos são partidos na pausa mais
    funda. Devolve [(início, fim)] em amostras."""
    import numpy as np

    hop = int(sr * 0.02)
    n = len(y) // hop
    if n == 0:
        return []
    rms = np.sqrt((y[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    voiced = rms > max(rms.max() * 0.06, 1e-4)
    gap = int(min_gap / 0.02)
    pieces, start, quiet = [], None, 0
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet >= gap:
                pieces.append((start, i - quiet + 1))
                start, quiet = None, 0
    if start is not None:
        pieces.append((start, n))
    out = []
    limit = int(max_len / 0.02)
    for a, b in pieces:
        while b - a > limit:  # parte na janela mais baixa da segunda metade
            lo = a + limit // 2
            cut = lo + int(np.argmin(rms[lo:a + limit]))
            out.append((a, cut))
            a = cut
        out.append((a, b))
    pad = int(0.1 / 0.02)
    return [(max(0, a - pad) * hop, min(n, b + pad) * hop) for a, b in out if (b - a) * 0.02 >= min_len]


# ACE-Step 1.5: o VAE de áudio gera 25 quadros latentes por segundo (48 kHz / 1920).
ACE15_FRAMES_PER_SECOND = 48000.0 / 1920.0


class TramaAudioWindow:
    """Marca um trecho de tempo de um latente de áudio para o KSampler regerar só ele
    (repaint / trocar a letra de um pedaço da música). Fora do trecho a máscara é 0 e o
    áudio original fica intacto; nas bordas a máscara sobe e desce em rampa (crossfade)
    para a emenda não estalar."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT", {"tooltip": "Latente da música (VAE Encode Audio do ACE-Step 1.5)."}),
                "start_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10000.0, "step": 0.01}),
                "end_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10000.0, "step": 0.01,
                                          "tooltip": "0 = até o fim da música."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                       "tooltip": "1 = regera o trecho por inteiro; 0,6 a 0,8 fica mais perto do original (melodia mais parecida)."}),
                "fade_seconds": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 5.0, "step": 0.05,
                                           "tooltip": "Rampa nas bordas do trecho, para a emenda ficar suave."}),
            }
        }

    RETURN_TYPES = ("LATENT", "FLOAT", "STRING")
    RETURN_NAMES = ("latent", "seconds", "summary")
    FUNCTION = "mark"
    CATEGORY = "audio/trama"
    DESCRIPTION = "Máscara de tempo num latente de áudio: o KSampler regera só esse trecho (repaint ou letra nova)."

    def mark(self, latent, start_seconds, end_seconds, strength, fade_seconds):
        samples = latent["samples"]
        total = samples.shape[-1]
        fps = ACE15_FRAMES_PER_SECOND
        a = max(0, min(total, int(round(start_seconds * fps))))
        b = total if end_seconds <= 0 else max(0, min(total, int(round(end_seconds * fps))))
        if b <= a:
            raise ValueError("end_seconds precisa ser maior que start_seconds (ou 0 para ir até o fim).")
        mask = torch.zeros(samples.shape[0], 1, total, dtype=torch.float32)
        mask[:, :, a:b] = float(strength)
        ramp = int(round(fade_seconds * fps))
        if ramp > 0:
            n = min(ramp, a)  # rampa de entrada antes do início
            if n > 0:
                mask[:, :, a - n:a] = torch.linspace(0, float(strength), n + 2)[1:-1]
            n = min(ramp, total - b)  # rampa de saída depois do fim
            if n > 0:
                mask[:, :, b:b + n] = torch.linspace(float(strength), 0, n + 2)[1:-1]
        out = dict(latent)
        out["noise_mask"] = mask.to(samples.device)
        seconds = total / fps
        summary = f"trecho {a / fps:.2f}s–{b / fps:.2f}s de {seconds:.2f}s, força {strength:.2f}, rampa {fade_seconds:.2f}s"
        print(f"[TramaAudioWindow] {summary}")
        return (out, seconds, summary)


_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _note(hz):
    if not hz or hz <= 0:
        return None
    midi = round(69 + 12 * math.log2(hz / 440.0))
    return f"{_NOTES[midi % 12]}{midi // 12 - 1}"


def _voice_stats(waveform, sample_rate, max_seconds=120):
    """Tom da voz (mediana e faixa), quanto do tempo tem voz e se parece canto ou fala."""
    import librosa
    import numpy as np

    mono = waveform.float().mean(dim=tuple(range(waveform.dim() - 1))).cpu().numpy()
    sr = 22050
    if sample_rate != sr:
        mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=sr)
    mono = mono[: sr * max_seconds]
    if mono.size < sr // 2:
        return None
    hop = 512
    f0 = librosa.yin(mono, fmin=65, fmax=1100, sr=sr, frame_length=2048, hop_length=hop)
    rms = librosa.feature.rms(y=mono, frame_length=2048, hop_length=hop)[0]
    n = min(len(f0), len(rms))
    f0, rms = f0[:n], rms[:n]
    loud = rms > max(rms.max() * 0.1, 1e-4)
    voiced = f0[loud]
    if voiced.size < 20:
        return {"voice_seconds": 0.0}
    semis = 12 * np.log2(voiced / 440.0)
    # Canto segura notas: muitos quadros seguidos com o tom quase parado.
    steady = np.abs(np.diff(semis)) < 0.35
    median = float(np.median(voiced))
    return {
        "median_hz": round(median, 1),
        "median_note": _note(median),
        "range_notes": [_note(float(np.percentile(voiced, 10))), _note(float(np.percentile(voiced, 90)))],
        "voice_seconds": round(float(loud.sum()) * hop / sr, 1),
        "steady_ratio": round(float(steady.mean()), 2),
    }


# Perfis de tonalidade de Krumhansl-Kessler (maior e menor).
_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _music_stats(audio, max_seconds=90):
    """Andamento (BPM) e tonalidade aproximados da música (do instrumental, se houver)."""
    import librosa
    import numpy as np

    mono = audio["waveform"].float().mean(dim=tuple(range(audio["waveform"].dim() - 1))).cpu().numpy()
    sr = 22050
    if audio["sample_rate"] != sr:
        mono = librosa.resample(mono, orig_sr=audio["sample_rate"], target_sr=sr)
    mono = mono[: sr * max_seconds]
    if mono.size < sr * 5:
        return {}
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    chroma = librosa.feature.chroma_cqt(y=mono, sr=sr).mean(axis=1)
    best = None
    for shift in range(12):
        for name, prof in (("major", _MAJOR), ("minor", _MINOR)):
            r = float(np.corrcoef(chroma, np.roll(prof, shift))[0, 1])
            if best is None or r > best[0]:
                best = (r, f"{_NOTES[shift]} {name}")
    # Detectores de batida erram pela metade ou pelo dobro com frequência: manda o outro também.
    alt = tempo * 2 if tempo < 100 else tempo / 2
    return {"tempo_bpm": int(round(tempo)), "tempo_bpm_alt": int(round(alt)), "key": best[1], "key_confidence": round(best[0], 2)}


class TramaAnalyzeAudio:
    """Mede um áudio para o agente decidir sozinho (sem perguntar ao usuário):
    duração, volume, se tem música além da voz, tom da voz e se é canto ou fala.
    Com as saídas do separador ligadas (vocals/instruments), mede a voz isolada."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"audio": ("AUDIO",)},
            "optional": {"vocals": ("AUDIO",), "instruments": ("AUDIO",)},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report",)
    FUNCTION = "analyze"
    OUTPUT_NODE = True
    CATEGORY = "audio/trama"
    DESCRIPTION = "Relatório em JSON: duração, volume, voz x música, tom da voz (Hz e nota), canto ou fala."

    def analyze(self, audio, vocals=None, instruments=None):
        import json

        sr = audio["sample_rate"]
        wave = audio["waveform"]
        report = {
            "duration_s": round(wave.shape[-1] / sr, 2),
            "channels": int(wave.shape[1]) if wave.dim() == 3 else 1,
            "loudness_db": round(_active_db(wave, sr), 1),
            "peak_db": round(20 * math.log10(float(wave.abs().max()) + 1e-9), 1),
        }
        voice_src = vocals if vocals is not None else audio
        if vocals is not None and instruments is not None:
            v = _active_db(vocals["waveform"], vocals["sample_rate"])
            i = _active_db(instruments["waveform"], instruments["sample_rate"])
            report["vocals_db"] = round(v, 1)
            report["instruments_db"] = round(i, 1)
            report["vocals_minus_instruments_db"] = round(v - i, 1)
            # Música de fundo forte: o instrumental tem energia parecida com a voz.
            report["has_music"] = bool(i > v - 15)
            report["is_voice_only"] = bool(i < v - 20)
        if report.get("has_music") or (vocals is None and report["duration_s"] > 20):
            report.update(_music_stats(instruments if instruments is not None else audio))
        stats = _voice_stats(voice_src["waveform"], voice_src["sample_rate"])
        if stats:
            report.update(stats)
            hz = stats.get("median_hz")
            if hz:
                report["voice_register"] = "grave" if hz < 165 else "médio" if hz < 260 else "agudo"
            sr_ = stats.get("steady_ratio")
            if sr_ is not None and stats.get("voice_seconds", 0) > 2:
                report["looks_like"] = "canto" if sr_ > 0.62 else "fala" if sr_ < 0.5 else "incerto"
        text = json.dumps(report, ensure_ascii=False)
        print(f"[TramaAnalyzeAudio] {text}")
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"TramaMatchVolume": TramaMatchVolume, "TramaAnalyzeAudio": TramaAnalyzeAudio, "TramaMixAudio": TramaMixAudio, "TramaAudioWindow": TramaAudioWindow, "TramaTranscribeAudio": TramaTranscribeAudio}
NODE_DISPLAY_NAME_MAPPINGS = {"TramaMatchVolume": "Igualar volume (Trama)", "TramaAnalyzeAudio": "Analisar áudio (Trama)", "TramaMixAudio": "Juntar áudios (Trama)", "TramaAudioWindow": "Trecho para regerar (Trama)", "TramaTranscribeAudio": "Transcrever voz (Trama)"}
