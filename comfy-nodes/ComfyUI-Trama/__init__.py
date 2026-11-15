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


NODE_CLASS_MAPPINGS = {"TramaMatchVolume": TramaMatchVolume, "TramaAnalyzeAudio": TramaAnalyzeAudio, "TramaMixAudio": TramaMixAudio}
NODE_DISPLAY_NAME_MAPPINGS = {"TramaMatchVolume": "Igualar volume (Trama)", "TramaAnalyzeAudio": "Analisar áudio (Trama)", "TramaMixAudio": "Juntar áudios (Trama)"}
