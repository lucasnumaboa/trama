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
    """Transcreve a voz com os tempos de cada frase e de cada palavra (Whisper small). Serve
    para achar onde uma frase é cantada antes de trocar a letra de um trecho, ou para saber
    o que é dito."""

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
    DESCRIPTION = "Texto da voz com início e fim de cada frase e de cada palavra, em JSON (Whisper small)."

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
            generate = {**kwargs, "max_new_tokens": 96}
            try:  # com o tempo de cada palavra, para achar a borda exata de uma frase dentro do pedaço
                outs = asr(inputs, batch_size=8, return_timestamps="word", generate_kwargs=generate)
            except Exception as error:
                print(f"[TramaTranscribeAudio] sem tempo por palavra ({error}); só o tempo de cada frase")
                outs = asr(inputs, batch_size=8, generate_kwargs=generate)
            for (a, b), o in zip(pieces, outs):
                text = (o.get("text") or "").strip()
                if not text:
                    continue
                start, end = a / 16000, b / 16000
                segment = {"start": round(start, 2), "end": round(end, 2), "text": text}
                words = []
                for chunk in o.get("chunks") or []:
                    ws, we = chunk.get("timestamp") or (None, None)
                    word = (chunk.get("text") or "").strip()
                    if word and ws is not None:
                        words.append([round(start + ws, 2), round(min(end, start + (we if we is not None else ws)), 2), word])
                if words:
                    # O Whisper fecha a última palavra antes de a nota sustentada acabar;
                    # o fim do pedaço vem do corte nas pausas e é mais confiável.
                    words[-1][1] = segment["end"]
                    segment["words"] = words  # [início, fim, palavra]
                segments.append(segment)
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
    """Marca um trecho de tempo de um latente de áudio para regerar só ele (repaint /
    trocar a letra de um pedaço da música). A máscara vale 1 no trecho e 0 fora. O nó
    TramaAceRepaint usa a marca para dar a música original de contexto ao modelo, e o
    TramaRepaintSplice para colar o trecho novo no áudio original."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT", {"tooltip": "Latente da música (VAE Encode Audio do ACE-Step 1.5)."}),
                "start_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10000.0, "step": 0.01}),
                "end_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10000.0, "step": 0.01,
                                          "tooltip": "0 = até o fim da música."}),
                "fade_seconds": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 5.0, "step": 0.05,
                                           "tooltip": "Crossfade em cada borda do trecho, na hora de colar no áudio original."}),
            }
        }

    RETURN_TYPES = ("LATENT", "FLOAT", "STRING")
    RETURN_NAMES = ("latent", "seconds", "summary")
    FUNCTION = "mark"
    CATEGORY = "audio/trama"
    DESCRIPTION = "Marca um trecho de tempo num latente de áudio do ACE-Step 1.5 para regerar só ele (repaint ou letra nova)."

    def mark(self, latent, start_seconds, end_seconds, fade_seconds):
        samples = latent["samples"]
        total = samples.shape[-1]
        fps = ACE15_FRAMES_PER_SECOND
        a = max(0, min(total, int(round(start_seconds * fps))))
        b = total if end_seconds <= 0 else max(0, min(total, int(round(end_seconds * fps))))
        if b <= a:
            raise ValueError("end_seconds precisa ser maior que start_seconds (ou 0 para ir até o fim).")
        mask = torch.zeros(samples.shape[0], 1, total, dtype=torch.float32)
        mask[:, :, a:b] = 1.0
        out = dict(latent)
        out["noise_mask"] = mask.to(samples.device)
        out["trama_window"] = {"start": a, "end": b, "fade": max(0, int(round(fade_seconds * fps)))}
        seconds = total / fps
        summary = f"trecho {a / fps:.2f}s–{b / fps:.2f}s de {seconds:.2f}s, crossfade {fade_seconds:.2f}s"
        print(f"[TramaAudioWindow] {summary}")
        return (out, seconds, summary)


def _window_frames(latent):
    """Quadros (início, fim, crossfade) do trecho marcado pelo TramaAudioWindow."""
    window = latent.get("trama_window")
    if window:
        return int(window["start"]), int(window["end"]), int(window.get("fade", 0))
    mask = latent.get("noise_mask")
    if mask is None:
        raise ValueError("ligue aqui a saída latent do nó 'Trecho para regerar (Trama)'.")
    on = torch.nonzero(mask.reshape(-1, mask.shape[-1])[0] > 0.5).flatten()
    if on.numel() == 0:
        raise ValueError("a máscara do trecho está vazia.")
    return int(on[0]), int(on[-1]) + 1, 0


# Instrução que o ComfyUI põe no prompt do modelo de áudio, e a que o ACE-Step usa no repaint.
COMFY_INSTRUCTION = "Generate audio semantic tokens based on the given conditions:"
REPAINT_INSTRUCTION = "Repaint the mask area based on the given conditions:"


class _RepaintTokenizer:
    """Tokenizer do ACE-Step 1.5 que troca a instrução do prompt do modelo de áudio pela
    de repaint. O ComfyUI monta esse prompt com a instrução fixa dentro da função, então
    a troca é feita no texto, na hora em que ele é tokenizado."""

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        if name == "_inner":
            raise AttributeError(name)
        return getattr(self._inner, name)

    def tokenize_with_weights(self, text, return_word_ids=False, **kwargs):
        sub = getattr(self._inner, "qwen3_06b", None)
        if sub is None:
            print("[TramaAceRepaint] aviso: este CLIP não é do ACE-Step 1.5; a instrução de repaint não foi aplicada.")
            return self._inner.tokenize_with_weights(text, return_word_ids, **kwargs)
        original = sub.tokenize_with_weights
        swapped = []

        def tokenize(prompt, *args, **kw):
            if isinstance(prompt, str) and prompt.startswith("# Instruction\n" + COMFY_INSTRUCTION):
                prompt = prompt.replace(COMFY_INSTRUCTION, REPAINT_INSTRUCTION, 1)
                swapped.append(True)
            return original(prompt, *args, **kw)

        sub.tokenize_with_weights = tokenize
        try:
            out = self._inner.tokenize_with_weights(text, return_word_ids, **kwargs)
        finally:
            sub.__dict__.pop("tokenize_with_weights", None)
        if not swapped:
            print("[TramaAceRepaint] aviso: o prompt do ComfyUI mudou de formato; a instrução de repaint não foi aplicada.")
        return out


class TramaAceRepaint:
    """Repaint de verdade do ACE-Step 1.5. O ComfyUI sempre entrega ao modelo um contexto
    vazio (fonte em silêncio e máscara toda em 1), que é o modo "criar música do zero".
    Este nó entrega o contexto do repaint oficial: a música original com o trecho em
    silêncio, mais a máscara que vale 1 só no trecho. Assim o modelo ouve o que vem antes
    e depois e continua a mesma música no trecho. Também segue a injeção oficial: a
    música original é reposta fora do trecho só na primeira parte dos passos."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "Modelo ACE-Step 1.5 (depois do ModelSamplingAuraFlow)."}),
                "clip": ("CLIP", {"tooltip": "CLIP do ACE-Step 1.5 (DualCLIPLoader tipo ace)."}),
                "latent": ("LATENT", {"tooltip": "Saída latent do nó 'Trecho para regerar (Trama)'."}),
                "injection_ratio": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                                              "tooltip": "Fração dos passos em que a música original é reposta fora do trecho. 0,5 é o padrão do ACE-Step; 1 repõe em todos os passos."}),
                "repaint_instruction": ("BOOLEAN", {"default": False,
                                                    "tooltip": "Usa no prompt a instrução de repaint do ACE-Step no lugar da instrução padrão do ComfyUI. Nos testes não melhorou o resultado; fica desligada por padrão."}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "patch"
    CATEGORY = "audio/trama"
    DESCRIPTION = "Repaint do ACE-Step 1.5: o modelo recebe a música original como contexto e regera só o trecho marcado."

    def patch(self, model, clip, latent, injection_ratio, repaint_instruction):
        import comfy.ldm.ace.ace_step15 as ace15

        samples = latent["samples"]
        if samples.dim() != 3 or samples.shape[1] != 64:
            raise ValueError("o latente não é de áudio do ACE-Step 1.5 (use o VAE Encode Audio com o ace_1.5_vae).")
        a, b, _ = _window_frames(latent)
        source = samples.detach().float().cpu().clone()  # [B, 64, T]
        silence = ace15.get_silence_latent(source.shape[-1], "cpu").float()
        source[:, :, a:b] = silence[:, :, a:b]
        chunk = torch.zeros_like(source)
        chunk[:, :, a:b] = 1.0
        context = torch.cat([source, chunk], dim=1).movedim(1, 2).contiguous()  # [B, T, 128]

        patched = model.clone()
        diffusion = patched.model.diffusion_model
        if not hasattr(diffusion, "prepare_condition"):
            raise ValueError("o modelo ligado não é o ACE-Step 1.5.")
        previous = patched.model_options.get("model_function_wrapper")

        def wrapper(apply_model, args):
            original = diffusion.prepare_condition

            def prepare_condition(*pa, **kw):
                enc_hidden, enc_mask, ctx = original(*pa, **kw)
                if ctx.shape[1:] != context.shape[1:]:
                    raise ValueError(f"o latente do repaint ({context.shape[1]} quadros) não é o mesmo que está sendo gerado ({ctx.shape[1]} quadros).")
                rep = context.to(device=ctx.device, dtype=ctx.dtype)
                if rep.shape[0] != ctx.shape[0]:
                    times = -(-ctx.shape[0] // rep.shape[0])
                    rep = rep.repeat(times, 1, 1)[: ctx.shape[0]]
                return enc_hidden, enc_mask, rep

            diffusion.prepare_condition = prepare_condition
            try:
                if previous is not None:
                    return previous(apply_model, args)
                return apply_model(args["input"], args["timestep"], **args["c"])
            finally:
                diffusion.__dict__.pop("prepare_condition", None)

        patched.set_model_unet_function_wrapper(wrapper)

        ratio = float(injection_ratio)

        def denoise_mask(sigma, mask, extra_options=None):
            # A máscara do KSampler repõe a música original fora do trecho a cada passo.
            # O repaint oficial faz isso só nos primeiros passos; depois o modelo fica
            # livre (o contexto já segura o resto) e as bordas se acomodam.
            sigmas = (extra_options or {}).get("sigmas")
            if sigmas is None or ratio >= 1.0:
                return mask
            cutoff = round(ratio * (len(sigmas) - 1))
            step = int(torch.argmin((sigmas.to(sigma.device).float() - sigma.flatten()[0].float()).abs()))
            return mask if step < cutoff else torch.ones_like(mask)

        patched.set_model_denoise_mask_function(denoise_mask)

        out_clip = clip
        if repaint_instruction:
            out_clip = clip.clone()
            out_clip.tokenizer = _RepaintTokenizer(clip.tokenizer)
        fps = ACE15_FRAMES_PER_SECOND
        print(f"[TramaAceRepaint] contexto do repaint: trecho {a / fps:.2f}s–{b / fps:.2f}s, injeção {ratio:.2f}, instrução de repaint {'sim' if repaint_instruction else 'não'}")
        return (patched, out_clip)


def _shift(x, k):
    """x deslocado para que saída[t] = x[t + k] (zeros onde falta sinal)."""
    if k == 0:
        return x
    out = torch.zeros_like(x)
    if k > 0:
        out[..., :-k] = x[..., k:]
    else:
        out[..., -k:] = x[..., :k]
    return out


def _best_lag(reference, signal, segments, max_lag):
    """Atraso k (em amostras) em que signal[t + k] mais se parece com reference[t] nos
    segmentos [(início, fim)], e a correlação nesse atraso. reference e signal são 1D."""
    n = signal.shape[-1]
    total = torch.zeros(2 * max_lag + 1, dtype=torch.float64)
    for s, e in segments:
        ref = reference[s:e].double()
        lo, hi = s - max_lag, e + max_lag
        sig = signal[max(0, lo):min(n, hi)].double()
        sig = torch.nn.functional.pad(sig, (max(0, -lo), max(0, hi - n)))
        size = 1 << (sig.shape[-1] - 1).bit_length()
        cc = torch.fft.irfft(torch.conj(torch.fft.rfft(ref, size)) * torch.fft.rfft(sig, size), size)
        total += cc[: 2 * max_lag + 1].cpu()
    k = int(torch.argmax(total)) - max_lag
    shifted = _shift(signal, k)
    ref = torch.cat([reference[s:e] for s, e in segments]).double()
    sig = torch.cat([shifted[s:e] for s, e in segments]).double()
    corr = float((ref * sig).sum() / (ref.norm() * sig.norm() + 1e-12))
    return k, corr


def _rms(x):
    return float(x.float().pow(2).mean().sqrt()) if x.numel() else 0.0


class TramaRepaintSplice:
    """Cola no áudio original só o trecho regerado. O resto da música não passa pelo VAE:
    fica igual ao original, amostra por amostra. O trecho novo é alinhado no tempo e
    igualado em volume pelo que vem antes e depois, e entra com crossfade nas bordas."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original": ("AUDIO", {"tooltip": "A música original (a mesma que foi para o VAE Encode Audio)."}),
                "generated": ("AUDIO", {"tooltip": "A música inteira decodificada depois do KSampler (VAE Decode Audio)."}),
                "window": ("LATENT", {"tooltip": "Saída latent do nó 'Trecho para regerar (Trama)'."}),
            }
        }

    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("audio", "summary")
    FUNCTION = "splice"
    CATEGORY = "audio/trama"
    DESCRIPTION = "Cola o trecho regerado na música original, com crossfade; o resto fica idêntico ao original."

    def splice(self, original, generated, window):
        import comfy.audio

        a, b, ramp = _window_frames(window)
        frames = window["samples"].shape[-1]
        fps = ACE15_FRAMES_PER_SECOND
        sr = original["sample_rate"]
        o = original["waveform"].float()  # [B, C, N]
        g = generated["waveform"].float().to(o.device)
        if generated["sample_rate"] != sr:
            g = comfy.audio.resample(g, generated["sample_rate"], sr)
        if g.shape[1] != o.shape[1]:
            g = g.mean(dim=1, keepdim=True).expand(-1, o.shape[1], -1)
        if g.shape[0] != o.shape[0]:
            g = g[:1].expand(o.shape[0], -1, -1)
        n = o.shape[-1]
        g = g[..., :n] if g.shape[-1] >= n else torch.nn.functional.pad(g, (0, n - g.shape[-1]))

        def at(frame):
            return max(0, min(n, int(round(frame / fps * sr))))

        i0 = at(a)
        i1 = n if b >= frames else at(b)
        fade = max(int(round(ramp / fps * sr)), int(0.02 * sr))
        f0 = max(0, i0 - fade) if i0 > 0 else 0
        f1 = min(n, i1 + fade) if i1 < n else n

        # O que vem antes e depois do trecho (até 4 s de cada lado) é a mesma música nos
        # dois áudios: serve para medir o atraso e a diferença de volume do áudio gerado.
        ctx = int(4 * sr)
        segments = [(s, e) for s, e in ((max(0, f0 - ctx), f0), (f1, min(n, f1 + ctx))) if e - s >= int(0.5 * sr)]
        lag, corr, gain = 0, 0.0, 1.0
        if segments:
            lag, corr = _best_lag(o[0].mean(dim=0), g[0].mean(dim=0), segments, int(0.05 * sr))
            if corr < 0.3:  # não parece a mesma música: não confia no atraso medido
                lag = 0
            g = _shift(g, lag)
            ref = _rms(torch.cat([o[..., s:e] for s, e in segments], dim=-1))
            cur = _rms(torch.cat([g[..., s:e] for s, e in segments], dim=-1))
            if cur > 1e-6:
                gain = max(0.25, min(4.0, ref / cur))
        # Mesmo ponto da música, só a letra muda: o trecho novo fica no volume do original.
        inner = 1.0
        cur = _rms(g[..., i0:i1]) * gain
        if cur > 1e-6:
            inner = max(0.5, min(2.0, _rms(o[..., i0:i1]) / cur))

        weight = torch.zeros(n, dtype=torch.float32, device=o.device)
        weight[i0:i1] = 1.0
        if i0 > f0:
            weight[f0:i0] = torch.linspace(0, 1, i0 - f0 + 2, device=o.device)[1:-1]
        if f1 > i1:
            weight[i1:f1] = torch.linspace(1, 0, f1 - i1 + 2, device=o.device)[1:-1]
        w = weight[f0:f1]
        # O ajuste do trecho entra e sai em rampa já dentro do trecho. No crossfade os
        # dois áudios são a mesma música, então ali vale só o ganho medido fora.
        level = torch.ones(f1 - f0, dtype=torch.float32, device=o.device)
        level[i0 - f0:i1 - f0] = inner
        r = min(fade, (i1 - i0) // 4)
        if r > 0:
            level[i0 - f0:i0 - f0 + r] = torch.linspace(1.0, inner, r + 2, device=o.device)[1:-1]
            level[i1 - f0 - r:i1 - f0] = torch.linspace(inner, 1.0, r + 2, device=o.device)[1:-1]
        new = g[..., f0:f1] * gain * level
        if new.numel() and float(new.abs().max()) > 0.999:
            new = _soft_limit(new)
        out = o.clone()
        out[..., f0:f1] = o[..., f0:f1] * (1.0 - w) + new * w

        summary = (f"trecho colado {i0 / sr:.2f}s–{i1 / sr:.2f}s (crossfade {fade / sr:.2f}s), atraso {lag} amostras "
                   f"(correlação {corr:.2f}), ganho {20 * math.log10(gain):+.1f} dB, ajuste do trecho {20 * math.log10(inner):+.1f} dB")
        print(f"[TramaRepaintSplice] {summary}")
        return ({"waveform": out.to(original["waveform"].dtype), "sample_rate": sr}, summary)


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


NODE_CLASS_MAPPINGS = {"TramaMatchVolume": TramaMatchVolume, "TramaAnalyzeAudio": TramaAnalyzeAudio, "TramaMixAudio": TramaMixAudio, "TramaAudioWindow": TramaAudioWindow, "TramaAceRepaint": TramaAceRepaint, "TramaRepaintSplice": TramaRepaintSplice, "TramaTranscribeAudio": TramaTranscribeAudio}
NODE_DISPLAY_NAME_MAPPINGS = {"TramaMatchVolume": "Igualar volume (Trama)", "TramaAnalyzeAudio": "Analisar áudio (Trama)", "TramaMixAudio": "Juntar áudios (Trama)", "TramaAudioWindow": "Trecho para regerar (Trama)", "TramaAceRepaint": "Repaint do ACE-Step 1.5 (Trama)", "TramaRepaintSplice": "Colar trecho na música (Trama)", "TramaTranscribeAudio": "Transcrever voz (Trama)"}
