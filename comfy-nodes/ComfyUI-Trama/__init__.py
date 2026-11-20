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


# ---- Modelo 3D com esqueleto ---------------------------------------------------
# O UniRig devolve um FBX com esqueleto e pesos. O Trama mostra e exporta GLB, então
# este nó converte o FBX em GLB com o Blender que o ComfyUI-UniRig instalou no
# ambiente isolado dele (comfy-env), e devolve os dois arquivos como saída.

_BLENDER_SCRIPT = r'''
import sys, bpy
src, dst = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True)
# O FBX do UniRig vem com o esqueleto em escala 0,01 e girado: aplica escala e rotação para o
# GLB sair limpo, em metros (os jogos e o Trama medem o tamanho certo).
bpy.ops.object.select_all(action="DESELECT")
for o in bpy.data.objects:
    if o.type in ("ARMATURE", "MESH"):
        o.select_set(True)
arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if arms:
    bpy.context.view_layer.objects.active = arms[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.ops.file.pack_all()
# O FBX volta com a transparência da textura ligada ao material: no GLB isso vira BLEND e o
# visualizador desenha o modelo com partes sumindo. O exportador do Blender 4.2 decide pela
# ligação no Alpha do Principled BSDF, então ela é desligada.
for mat in bpy.data.materials:
    mat.blend_method = "OPAQUE"
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            alpha = node.inputs.get("Alpha") if node.type == "BSDF_PRINCIPLED" else None
            if alpha is not None:
                for link in list(alpha.links):
                    mat.node_tree.links.remove(link)
                alpha.default_value = 1.0
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_skins=True, export_animations=True, export_yup=True, export_image_format="AUTO")
arm = [o for o in bpy.data.objects if o.type == "ARMATURE"]
print("TRAMA_BONES", sum(len(a.data.bones) for a in arm))
'''


def _blender_python():
    import glob
    import os
    env = os.environ.get("TRAMA_BLENDER_PYTHON")
    if env and os.path.exists(env):
        return env
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "comfy-env", "envs")
    found = sorted(glob.glob(os.path.join(base, "*", ".pixi", "envs", "default", "python.exe")), key=lambda p: ("unirig" not in p.lower(), p))
    for py in found:
        if glob.glob(os.path.join(os.path.dirname(py), "Lib", "site-packages", "bpy*")):
            return py
    raise RuntimeError("Não achei o Blender (bpy) do ComfyUI-UniRig. Instale o ComfyUI-UniRig ou defina TRAMA_BLENDER_PYTHON.")


def _run_blender(script_text, args, timeout=900):
    """Roda um script no Blender (bpy) do ambiente do UniRig e devolve stdout+stderr."""
    import os
    import subprocess
    import tempfile
    py = _blender_python()
    root = os.path.dirname(py)
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([root, os.path.join(root, "Library", "bin"), os.path.join(root, "Library", "mingw-w64", "bin"), os.path.join(root, "Scripts"), env.get("PATH", "")])
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(script_text)
        path = f.name
    try:
        r = subprocess.run([py, path, *args], env=env, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    finally:
        os.unlink(path)
    out = (r.stdout or "") + (r.stderr or "")
    err = next((l[len("TRAMA_ERROR "):] for l in out.splitlines() if l.startswith("TRAMA_ERROR ")), None)
    if err:
        raise RuntimeError(err)
    if r.returncode != 0:
        raise RuntimeError(f"O Blender falhou: {out[-800:]}")
    return out


_ANIMATE_SCRIPT = r'''
import sys, math, bpy
from mathutils import Vector, Quaternion

src, dst_glb, dst_fbx, motion, seconds = sys.argv[-5:]
seconds = float(seconds)
FPS = 30

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm is None:
    print("TRAMA_ERROR o modelo não tem esqueleto: passe antes pelo workflow de esqueleto (rig).")
    sys.exit(2)


def find(name):
    for b in arm.data.bones:
        n = b.name.split(":")[-1]
        if n.startswith("mixamorig"):
            n = n[len("mixamorig"):]
        if n == name:
            return b.name
    return None


NEED = ["Hips", "Spine", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm"]
B = {n: find(n) for n in NEED + ["Spine1", "Spine2", "Neck", "Head", "LeftToeBase", "RightToeBase"]}
missing = [n for n in NEED if not B[n]]
if missing:
    print("TRAMA_ERROR a animação precisa de um esqueleto humanoide (template mixamo); faltam os ossos " + ", ".join(missing))
    sys.exit(2)

bones = arm.data.bones
head = lambda n: bones[B[n]].head_local.copy()
UP = (arm.matrix_world.inverted().to_3x3() @ Vector((0, 0, 1))).normalized()
toe = B["LeftToeBase"] or B["RightToeBase"]
fwd = (bones[toe].head_local - head("LeftFoot")) if toe else Vector((0, -1, 0))
fwd = fwd - UP * fwd.dot(UP)
F = fwd.normalized() if fwd.length > 1e-6 else Vector((0, -1, 0))
S = F.cross(UP).normalized()  # girar +θ em S leva para a frente um osso que aponta para baixo
LEG = max(1e-3, (head("Hips") - head("LeftFoot")).dot(UP))
rad = math.radians


def q(axis, deg):
    return Quaternion(axis, rad(deg))


def arm_down(side):
    v = (head(side + "ForeArm") - head(side + "Arm")).normalized()
    elev = math.degrees(math.asin(max(-1, min(1, v.dot(UP)))))
    need = 72 + elev  # deixa o braço 72° abaixo da horizontal
    sign = 1 if (q(F, need) @ v).dot(UP) < v.dot(UP) else -1
    return F, sign * need, v


DOWN = {s: arm_down(s) for s in ("Left", "Right")}


def elbow_axis(side):
    v = DOWN[side][2]
    sign = 1 if (q(UP, 20) @ v).dot(F) > v.dot(F) else -1
    return UP, sign


ELBOW = {s: elbow_axis(s) for s in ("Left", "Right")}


def to_local(name, q_arm):
    m = bones[name].matrix_local.to_3x3().normalized().to_quaternion()
    return m.inverted() @ q_arm @ m


def smooth(a, b, x):
    x = max(0.0, min(1.0, x))
    x = x * x * (3 - 2 * x)
    return a + (b - a) * x


# ---- poses: dict de parâmetros em graus / fração da perna ----------------------
BASE = dict(hips_up=0, hips_fwd=0, lean=0, twist=0, sway=0, nod=0,
            thighL=0, thighR=0, kneeL=4, kneeR=4, footL=0, footR=0,
            swingL=0, swingR=0, elbowL=18, elbowR=18)


def cycle(t, T, amp):
    p = 2 * math.pi * t / T
    s, c = math.sin(p), math.cos(p)
    a = amp
    d = dict(BASE)
    d.update(
        thighL=a["thigh"] * s, thighR=-a["thigh"] * s,
        kneeL=a["knee0"] + a["knee"] * max(0, c), kneeR=a["knee0"] + a["knee"] * max(0, -c),
        swingL=-a["arm"] * s, swingR=a["arm"] * s,
        elbowL=a["elbow"], elbowR=a["elbow"],
        hips_up=a["bob"] * math.cos(2 * p) - a["drop"], lean=a["lean"], twist=a["twist"] * s, sway=a["sway"] * s,
    )
    d["footL"] = -(d["thighL"] - d["kneeL"]) * 0.5
    d["footR"] = -(d["thighR"] - d["kneeR"]) * 0.5
    return d


WALK = dict(thigh=24, knee0=5, knee=38, arm=22, elbow=20, bob=0.025, drop=0.02, lean=3, twist=6, sway=3)
RUN = dict(thigh=42, knee0=15, knee=75, arm=45, elbow=85, bob=0.05, drop=0.06, lean=12, twist=10, sway=2)

JUMP = [  # (tempo, parâmetros)
    (0.00, dict()),
    (0.35, dict(thighL=55, thighR=55, kneeL=100, kneeR=100, footL=45, footR=45, hips_up=-0.28, lean=25, swingL=-50, swingR=-50, elbowL=20, elbowR=20)),
    (0.50, dict(thighL=-5, thighR=-5, kneeL=0, kneeR=0, footL=-35, footR=-35, hips_up=0.12, lean=-4, swingL=150, swingR=150, elbowL=10, elbowR=10)),
    (0.75, dict(thighL=35, thighR=35, kneeL=70, kneeR=70, footL=10, footR=10, hips_up=0.45, lean=6, swingL=120, swingR=120, elbowL=25, elbowR=25)),
    (1.00, dict(thighL=12, thighR=12, kneeL=18, kneeR=18, footL=-10, footR=-10, hips_up=0.04, lean=4, swingL=60, swingR=60)),
    (1.15, dict(thighL=48, thighR=48, kneeL=90, kneeR=90, footL=42, footR=42, hips_up=-0.24, lean=20, swingL=-20, swingR=-20, elbowL=30, elbowR=30)),
    (1.55, dict()),
]


def keyed(t, keys):
    full = [(k, {**BASE, **v}) for k, v in keys]
    for (t0, a), (t1, b) in zip(full, full[1:]):
        if t <= t1:
            x = (t - t0) / max(1e-6, t1 - t0)
            return {n: smooth(a[n], b[n], x) for n in BASE}
    return full[-1][1]


def idle(t, T=3.0):
    p = 2 * math.pi * t / T
    d = dict(BASE)
    d.update(lean=2 * math.sin(p), hips_up=0.006 * math.sin(p), nod=2 * math.sin(p + 1), swingL=3 * math.sin(p), swingR=3 * math.sin(p + 0.5), elbowL=12, elbowR=12)
    return d


if motion == "walk":
    T = 1.0
    pose = lambda t: cycle(t, T, WALK)
elif motion == "run":
    T = 0.6
    pose = lambda t: cycle(t, T, RUN)
elif motion == "idle":
    T = 3.0
    pose = idle
elif motion == "jump":
    T = JUMP[-1][0]
    pose = lambda t: keyed(t, JUMP)
else:
    print("TRAMA_ERROR movimento desconhecido: " + motion)
    sys.exit(2)

loops = 1 if motion == "jump" else max(1, round(seconds / T))
total = T * loops
frames = int(round(total * FPS))

scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 0
scene.frame_end = frames - 1 if motion != "jump" else frames

for pb in arm.pose.bones:
    pb.rotation_mode = "QUATERNION"
arm.animation_data_create()
arm.animation_data.action = bpy.data.actions.new(motion)


def apply(d, frame):
    pbs = arm.pose.bones
    rots = {
        "Hips": q(UP, d["sway"]),
        "Spine": q(UP, d["twist"]) @ q(S, -d["lean"]),
        "LeftUpLeg": q(S, d["thighL"]), "RightUpLeg": q(S, d["thighR"]),
        "LeftLeg": q(S, -d["kneeL"]), "RightLeg": q(S, -d["kneeR"]),
        "LeftFoot": q(S, d["footL"]), "RightFoot": q(S, d["footR"]),
    }
    if B["Head"]:
        rots["Head"] = q(S, -d["nod"])
    for side in ("Left", "Right"):
        ax, ang, _ = DOWN[side]
        rots[side + "Arm"] = q(S, d["swing" + side[0]]) @ q(ax, ang)
        eax, esign = ELBOW[side]
        rots[side + "ForeArm"] = q(eax, esign * d["elbow" + side[0]])
    for n, qa in rots.items():
        pb = pbs[B[n]]
        pb.rotation_quaternion = to_local(B[n], qa)
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    hips = pbs[B["Hips"]]
    delta = UP * d["hips_up"] * LEG + F * d["hips_fwd"] * LEG
    m = bones[B["Hips"]].matrix_local.to_3x3().normalized()
    hips.location = m.inverted() @ delta
    hips.keyframe_insert("location", frame=frame)


last = frames if motion == "jump" else frames - 1
for f in range(0, last + 1):
    apply(pose(f / FPS), f)

bpy.ops.file.pack_all()
bpy.ops.export_scene.gltf(filepath=dst_glb, export_format="GLB", export_skins=True, export_animations=True, export_yup=True, export_force_sampling=True)
bpy.ops.export_scene.fbx(filepath=dst_fbx, bake_anim=True, add_leaf_bones=False, path_mode="COPY", embed_textures=True)
print("TRAMA_ANIM", motion, frames, round(total, 2))
'''


class TramaLoadMesh:
    """Carrega um modelo 3D da pasta input para os nós do UniRig.

    O UniRig: Load Mesh lista os arquivos de input/3d só quando o ComfyUI abre, então
    um modelo enviado depois é recusado ("Value not in list"). Este nó recebe o caminho
    como texto e devolve a malha (trimesh), que o comfy-env passa ao ambiente do UniRig.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mesh": ("STRING", {"default": "3d/realistic_male_character.glb",
                                    "tooltip": "Caminho do modelo dentro da pasta input (GLB, GLTF, OBJ, PLY, STL)."}),
            }
        }

    RETURN_TYPES = ("TRIMESH",)
    RETURN_NAMES = ("mesh",)
    FUNCTION = "load"
    CATEGORY = "Trama"

    @classmethod
    def IS_CHANGED(cls, mesh):
        import os
        import folder_paths
        path = os.path.join(folder_paths.get_input_directory(), mesh)
        return os.path.getmtime(path) if os.path.exists(path) else mesh

    def load(self, mesh):
        import os
        import folder_paths
        import trimesh

        root = folder_paths.get_input_directory()
        path = os.path.abspath(os.path.join(root, mesh))
        if not path.lower().startswith(os.path.abspath(root).lower() + os.sep):
            raise ValueError("O modelo precisa estar dentro da pasta input do ComfyUI.")
        if not os.path.exists(path):
            raise ValueError(f"Modelo não encontrado: {mesh}")
        loaded = trimesh.load(path, process=False, maintain_order=True)
        if isinstance(loaded, trimesh.Scene):
            loaded = loaded.to_geometry()
        if loaded is None or len(loaded.vertices) == 0 or len(loaded.faces) == 0:
            raise ValueError(f"O modelo está vazio: {mesh}")
        keep = loaded.unique_faces() & loaded.nondegenerate_faces()
        if not keep.all():
            loaded.update_faces(keep)
        loaded.remove_unreferenced_vertices()
        print(f"[Trama] modelo carregado: {len(loaded.vertices)} vértices, {len(loaded.faces)} faces")
        return (loaded,)


class TramaRiggedToGlb:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "fbx_output_path": ("STRING", {"forceInput": True, "tooltip": "FBX com esqueleto (saída do UniRig: Auto Rig), relativo à pasta output."}),
                "filename_prefix": ("STRING", {"default": "trama/trama_3d_rig"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("glb_path",)
    FUNCTION = "convert"
    OUTPUT_NODE = True
    CATEGORY = "Trama"
    DESCRIPTION = "Converte o FBX com esqueleto do UniRig em GLB (com ossos e pesos) e salva os dois na pasta output."

    def convert(self, fbx_output_path, filename_prefix):
        import os
        import shutil
        import subprocess
        import tempfile
        import folder_paths

        out_dir = folder_paths.get_output_directory()
        src = fbx_output_path if os.path.isabs(fbx_output_path) else os.path.join(out_dir, fbx_output_path)
        if not os.path.exists(src):
            raise RuntimeError(f"FBX não encontrado: {src}")
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
        os.makedirs(full_folder, exist_ok=True)
        stem = f"{filename}_{counter:05}_"
        glb = os.path.join(full_folder, stem + ".glb")
        fbx = os.path.join(full_folder, stem + ".fbx")
        shutil.copy(src, fbx)

        py = _blender_python()
        root = os.path.dirname(py)
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([root, os.path.join(root, "Library", "bin"), os.path.join(root, "Library", "mingw-w64", "bin"), os.path.join(root, "Scripts"), env.get("PATH", "")])
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(_BLENDER_SCRIPT)
            script = f.name
        try:
            r = subprocess.run([py, script, fbx, glb], env=env, capture_output=True, text=True, timeout=600)
        finally:
            os.unlink(script)
        if r.returncode != 0 or not os.path.exists(glb):
            raise RuntimeError(f"O Blender não converteu o FBX: {(r.stderr or r.stdout)[-800:]}")
        bones = next((l.split()[-1] for l in r.stdout.splitlines() if l.startswith("TRAMA_BONES")), "?")
        print(f"[Trama] GLB com esqueleto: {glb} ({bones} ossos)")
        # Só o GLB é o resultado (vira o card); o FBX fica ao lado, com o mesmo nome, para o Exportar.
        files = [{"filename": os.path.basename(glb), "subfolder": subfolder, "type": "output"}]
        rel = os.path.relpath(glb, out_dir)
        return {"ui": {"3d": files, "text": [f"{bones} ossos"]}, "result": (rel,)}


# ---- Imagem para 3D: objeto escuro ------------------------------------------
class TramaAnimate3D:
    """Anima um modelo 3D com esqueleto humanoide (template mixamo do UniRig).

    Não usa arquivos de animação de fora: monta o movimento direto nos ossos, quadro a
    quadro, no Blender do ambiente do UniRig. Acha para onde o personagem olha pelos
    ossos do pé, baixa os braços da T-pose e gera andar, correr e parado (em loop) ou
    pular. Salva GLB (o card, que toca a animação) e FBX (Exportar).
    """

    MOTIONS = ["walk", "run", "jump", "idle"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("STRING", {"default": "3d/modelo_com_esqueleto.glb",
                                     "tooltip": "GLB com esqueleto (saída do workflow de esqueleto), dentro da pasta input."}),
                "motion": (cls.MOTIONS, {"default": "walk", "tooltip": "walk = andar, run = correr, jump = pular, idle = parado respirando."}),
                "seconds": ("FLOAT", {"default": 2.0, "min": 0.5, "max": 20.0, "step": 0.5,
                                      "tooltip": "Duração do loop (andar, correr, parado); arredonda para ciclos inteiros. O pulo dura 1,55 s."}),
                "filename_prefix": ("STRING", {"default": "trama/trama_3d_animado"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("glb_path",)
    FUNCTION = "animate"
    OUTPUT_NODE = True
    CATEGORY = "Trama"

    def animate(self, model, motion, seconds, filename_prefix):
        import os
        import folder_paths

        root = folder_paths.get_input_directory()
        src = os.path.abspath(os.path.join(root, model))
        if not os.path.exists(src):
            raise RuntimeError(f"Modelo não encontrado: {model}")
        out_dir = folder_paths.get_output_directory()
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
        os.makedirs(full_folder, exist_ok=True)
        stem = f"{filename}_{counter:05}_"
        glb = os.path.join(full_folder, stem + ".glb")
        fbx = os.path.join(full_folder, stem + ".fbx")
        out = _run_blender(_ANIMATE_SCRIPT, [src, glb, fbx, motion, str(seconds)])
        if not os.path.exists(glb):
            raise RuntimeError(f"O Blender não gerou a animação: {out[-800:]}")
        info = next((l for l in out.splitlines() if l.startswith("TRAMA_ANIM")), "")
        print(f"[Trama] animação: {glb} ({info})")
        files = [{"filename": os.path.basename(glb), "subfolder": subfolder, "type": "output"}]
        gif = _render_gif(glb, subfolder)
        ui = {"3d": files, "text": [info]}
        if gif:
            ui["images"] = [gif]
        return {"ui": ui, "result": (os.path.relpath(glb, out_dir),)}


_GLB_TO_FBX_SCRIPT = r'''
import sys, bpy
src, dst = sys.argv[-2:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
if not any(o.type == "ARMATURE" for o in bpy.data.objects):
    print("TRAMA_ERROR o GLB animado veio sem esqueleto")
    sys.exit(2)
bpy.ops.export_scene.fbx(filepath=dst, bake_anim=True, add_leaf_bones=False, path_mode="COPY", embed_textures=True)
print("TRAMA_FBX ok")
'''


# Prévia em GIF de um GLB animado (Workbench do Blender, câmera em 3/4 pela frente do
# personagem, chão claro). A frente vem da média da direção pé → ponta do pé em todos os
# quadros, porque o retarget pode deixar o personagem olhando para qualquer lado.
_GIF_SCRIPT = r'''
import sys, os, math, shutil
import bpy
from mathutils import Vector

src, out = [os.path.abspath(p) for p in sys.argv[-2:]]
SIZE = 420
FPS = 30
STEP = 2  # 30 fps -> 15 fps no GIF

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
scene = bpy.context.scene
arm = next((o for o in scene.objects if o.type == "ARMATURE"), None)
meshes = [o for o in scene.objects if o.type == "MESH"]
if not meshes:
    print("TRAMA_ERROR o GLB não tem malha")
    sys.exit(2)
act = arm.animation_data.action if arm and arm.animation_data else None
f0, f1 = (int(act.frame_range[0]), int(act.frame_range[1])) if act else (1, 1)
scene.frame_start, scene.frame_end = f0, f1

lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for f in range(f0, f1 + 1, max(1, (f1 - f0) // 24 or 1)):
    scene.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    for m in meshes:
        ev = m.evaluated_get(dg)
        me = ev.to_mesh()
        mw = ev.matrix_world
        for v in list(me.vertices)[:: max(1, len(me.vertices) // 4000)]:
            p = mw @ v.co
            lo = Vector(map(min, lo, p)); hi = Vector(map(max, hi, p))
        ev.to_mesh_clear()
center = (lo + hi) / 2
ext = hi - lo

front = Vector((0, -1, 0))
if arm:
    pb = arm.pose.bones
    acc = Vector((0, 0, 0))
    for f in range(f0, f1 + 1, 3):
        scene.frame_set(f)
        for side_ in ("Left", "Right"):
            fa, fb = pb.get("mixamorig:%sFoot" % side_), pb.get("mixamorig:%sToeBase" % side_)
            if fa and fb:
                d = (arm.matrix_world @ fb.head) - (arm.matrix_world @ fa.head)
                acc += Vector((d.x, d.y, 0))
    if acc.length > 1e-6:
        front = acc.normalized()
ang = math.radians(35)
side = Vector((-front.y, front.x, 0))
dirv = (front * math.cos(ang) + side * math.sin(ang)).normalized()
dirv.z = 0.25
dirv.normalize()

cam_data = bpy.data.cameras.new("cam"); cam_data.type = "ORTHO"
span = max(ext.x, ext.y, ext.z)
cam_data.ortho_scale = span * 1.15
cam = bpy.data.objects.new("cam", cam_data); scene.collection.objects.link(cam)
cam.location = center + dirv * (span * 4)
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.clip_end = span * 20
scene.camera = cam

bpy.ops.mesh.primitive_plane_add(size=span * 6, location=(center.x, center.y, lo.z))
floor_mat = bpy.data.materials.new("chao"); floor_mat.diffuse_color = (0.85, 0.85, 0.85, 1)
bpy.context.object.data.materials.append(floor_mat)

scene.render.engine = "BLENDER_WORKBENCH"
sh = scene.display.shading
sh.light = "STUDIO"
sh.color_type = "TEXTURE"
sh.show_shadows = True
sh.show_cavity = False
scene.display.shadow_shift = 0.1
sh.background_type = "VIEWPORT"
sh.background_color = (0.93, 0.93, 0.93)
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"

tmp = out + "_frames"
os.makedirs(tmp, exist_ok=True)
frames = []
try:
    for f in range(f0, f1 + 1, STEP):
        scene.frame_set(f)
        p = os.path.join(tmp, "%04d.png" % f)
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        frames.append(p)
    from PIL import Image
    imgs = [Image.open(p).convert("RGB") for p in frames]
    pal = [im.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for im in imgs]
    pal[0].save(out, save_all=True, append_images=pal[1:], duration=int(1000 * STEP / FPS), loop=0, optimize=True)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("TRAMA_GIF %d quadros" % len(frames))
'''


def _render_gif(glb, subfolder):
    """GIF ao lado do GLB (mesmo nome). Devolve o item de saída ou None se falhar."""
    import os
    gif = glb[:-4] + ".gif"
    try:
        _run_blender(_GIF_SCRIPT, [glb, gif], timeout=600)
    except Exception as e:  # o card 3D sai mesmo sem a prévia
        print(f"[Trama] GIF da animação não saiu: {e}")
        return None
    if not os.path.exists(gif):
        return None
    return {"filename": os.path.basename(gif), "subfolder": subfolder, "type": "output"}


class TramaMotionToModel:
    """Põe um movimento do HY-Motion (texto → movimento) no modelo 3D com esqueleto.

    Usa o retarget do ComfyUI-HY-Motion1 (nó HY-Motion Export GLB) no GLB com esqueleto
    mixamo do workflow de esqueleto. O GLB animado vira o card; o FBX fica ao lado, com
    o mesmo nome, para o Exportar.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "motion_data": ("HYMOTION_DATA",),
                "model": ("STRING", {"default": "3d/modelo_com_esqueleto.glb",
                                     "tooltip": "GLB com esqueleto mixamo (saída do workflow de esqueleto), dentro da pasta input."}),
                "filename_prefix": ("STRING", {"default": "trama/trama_3d_movimento"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("glb_path",)
    FUNCTION = "apply"
    OUTPUT_NODE = True
    CATEGORY = "Trama"

    def apply(self, motion_data, model, filename_prefix):
        import os
        import shutil
        import folder_paths
        import nodes

        export_cls = nodes.NODE_CLASS_MAPPINGS.get("HYMotionExportGLB")
        if export_cls is None:
            raise RuntimeError("Falta o nó ComfyUI-HY-Motion1 (HY-Motion Export GLB) no ComfyUI.")
        src = os.path.abspath(os.path.join(folder_paths.get_input_directory(), model))
        if not os.path.exists(src):
            raise RuntimeError(f"Modelo não encontrado: {model}")
        out_dir = folder_paths.get_output_directory()
        tmp_rel = os.path.join("trama", "_hymotion_tmp")
        res = export_cls().export(motion_data, src, tmp_rel, "movimento", 0.0, 0.0)
        made = [os.path.join(out_dir, p) for p in str(res[0]).splitlines() if p.strip().endswith(".glb")]
        made = [p for p in made if os.path.exists(p)]
        if not made:
            raise RuntimeError(f"O HY-Motion não pôs o movimento no modelo ({res[0]}). O modelo precisa de esqueleto mixamo (workflow de esqueleto com template mixamo).")

        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
        os.makedirs(full_folder, exist_ok=True)
        stem = f"{filename}_{counter:05}_"
        glb = os.path.join(full_folder, stem + ".glb")
        fbx = os.path.join(full_folder, stem + ".fbx")
        shutil.move(made[0], glb)
        for p in made:
            for extra in (p, p[:-4] + ".txt"):
                if os.path.exists(extra):
                    os.remove(extra)
        try:
            _run_blender(_GLB_TO_FBX_SCRIPT, [glb, fbx])
        except Exception as e:  # o card sai mesmo sem o FBX
            print(f"[Trama] FBX do movimento não saiu: {e}")
        print(f"[Trama] movimento: {glb}")
        files = [{"filename": os.path.basename(glb), "subfolder": subfolder, "type": "output"}]
        gif = _render_gif(glb, subfolder)
        ui = {"3d": files, "text": [motion_data.text]}
        if gif:
            ui["images"] = [gif]
        return {"ui": ui, "result": (os.path.relpath(glb, out_dir),)}


class TramaImageStyle:
    """Diz se a imagem é um desenho chapado em preto e branco (traço, cartum sem sombra).

    O TRELLIS.2 aprende com objetos que têm volume e luz: com desenho chapado ele pinta
    a textura quase toda escura e perde as partes brancas. O Trama usa este nó antes de
    gerar um modelo 3D para decidir se transforma o desenho num boneco 3D primeiro.

    Mede só o objeto: usa a transparência da imagem quando houver; senão, o que difere
    da cor dos cantos. Chapado = quase sem cor (saturação baixa) e quase sem meios-tons
    (pouca coisa entre o preto e o branco).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": ("IMAGE",)},
            "optional": {"mask": ("MASK", {"tooltip": "Máscara do Load Image (1 = transparente)."})},
        }

    RETURN_TYPES = ("BOOLEAN", "STRING")
    RETURN_NAMES = ("flat", "report")
    FUNCTION = "analyze"
    OUTPUT_NODE = True
    CATEGORY = "Trama"

    @staticmethod
    def measure(image, mask=None):
        import json
        img = image[0, ..., :3].float()  # [H, W, 3]
        h, w = img.shape[:2]
        fg = None
        if mask is not None and mask.numel() > 1:
            m = mask[0] if mask.dim() == 3 else mask
            if m.shape == (h, w) and float(m.max()) > 0.5:  # tem transparência
                fg = m < 0.5
        if fg is None:
            k = max(2, min(h, w) // 40)
            corners = torch.cat([img[:k, :k].reshape(-1, 3), img[:k, -k:].reshape(-1, 3), img[-k:, :k].reshape(-1, 3), img[-k:, -k:].reshape(-1, 3)])
            bg = corners.median(dim=0).values
            fg = (img - bg).abs().max(dim=-1).values > 0.12
        n = int(fg.sum())
        if n < 0.01 * h * w:
            return False, json.dumps({"flat": False, "reason": "objeto não encontrado"})
        px = img[fg]
        mx = px.max(dim=-1).values
        mn = px.min(dim=-1).values
        sat = torch.where(mx > 0.05, (mx - mn) / mx.clamp(min=1e-6), torch.zeros_like(mx))
        luma = px @ torch.tensor([0.299, 0.587, 0.114], device=px.device)
        mean_sat = float(sat.mean())
        mid = float(((luma > 0.25) & (luma < 0.75)).float().mean())
        dark = float((luma <= 0.25).float().mean())
        flat = mean_sat < 0.15 and mid < 0.12 and dark > 0.1
        report = {"flat": flat, "mean_saturation": round(mean_sat, 3), "midtones": round(mid, 3), "dark": round(dark, 3), "object_share": round(n / (h * w), 3)}
        return flat, json.dumps(report)

    def analyze(self, image, mask=None):
        flat, report = self.measure(image, mask)
        print(f"[Trama] estilo da imagem: {report}")
        return {"ui": {"text": [report]}, "result": (flat, report)}


class TramaContrastBackground:
    """Cor de fundo para recortar o objeto antes do TRELLIS.2.

    O TRELLIS.2 espera o objeto sobre fundo preto. Com um personagem quase todo preto
    (desenho preto e branco, roupa escura), o objeto some no fundo e a textura sai
    preta e metálica. Este nó mede o objeto pela máscara e devolve preto quando ele é
    claro o bastante e cinza médio quando é escuro.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "dark_share": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 1.0, "step": 0.05,
                                         "tooltip": "Fração do objeto que precisa ser escura para trocar o fundo preto pelo cinza."}),
            }
        }

    # COLOR: o tipo do campo background do Crop Image to Mask (um hex como "#808080").
    RETURN_TYPES = ("COLOR", "BOOLEAN")
    RETURN_NAMES = ("background", "dark")
    FUNCTION = "pick"
    CATEGORY = "Trama"

    def pick(self, image, mask, dark_share):
        img = image[0].float()  # [H, W, C]
        m = mask[0].float() if mask.dim() == 3 else mask.float()
        if m.shape != img.shape[:2]:
            m = torch.nn.functional.interpolate(m[None, None], size=img.shape[:2], mode="bilinear")[0, 0]
        inside = m > 0.5
        if int(inside.sum()) == 0:
            return ("#000000", False)
        luma = (img[..., :3] * torch.tensor([0.299, 0.587, 0.114], device=img.device)).sum(-1)
        dark = float((luma[inside] < 0.18).float().mean())
        color = "#808080" if dark >= dark_share else "#000000"
        print(f"[Trama] fundo para o 3D: {color} ({dark:.0%} do objeto é escuro)")
        return (color, dark >= dark_share)


class TramaMatchColor:
    """Tira da textura a cor que o TRELLIS.2 inventou num personagem preto e branco.

    O modelo inventa o que não aparece na imagem (costas, nuca, às vezes as pernas) e
    em personagem preto e branco costuma pintar essas partes de marrom ou tom de pele.
    Se o objeto da imagem de origem não tem cor (saturação média baixa), a textura vira
    tons de cinza; com cor na origem, passa sem mudança.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_color": ("IMAGE",),
                "image": ("IMAGE", {"tooltip": "Imagem de origem do modelo 3D."}),
                "mask": ("MASK", {"tooltip": "Máscara do objeto na imagem de origem (1 = objeto)."}),
                "max_saturation": ("FLOAT", {"default": 0.12, "min": 0.0, "max": 1.0, "step": 0.01,
                                             "tooltip": "Abaixo desta saturação média a origem conta como preto e branco."}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("base_color",)
    FUNCTION = "match"
    CATEGORY = "Trama"

    def match(self, base_color, image, mask, max_saturation):
        img = image[0, ..., :3].float()
        m = mask[0].float() if mask.dim() == 3 else mask.float()
        if m.shape != img.shape[:2]:
            m = torch.nn.functional.interpolate(m[None, None], size=img.shape[:2], mode="bilinear")[0, 0]
        inside = m > 0.5
        if int(inside.sum()) == 0:
            return (base_color,)
        px = img[inside]
        mx = px.max(dim=-1).values
        mn = px.min(dim=-1).values
        sat = float(torch.where(mx > 0.05, (mx - mn) / mx.clamp(min=1e-6), torch.zeros_like(mx)).mean())
        if sat >= max_saturation:
            return (base_color,)
        rgb = base_color[..., :3]
        luma = (rgb * torch.tensor([0.299, 0.587, 0.114], device=rgb.device)).sum(-1, keepdim=True)
        # Cartum preto e branco: empurra os escuros para o preto e os claros para o branco
        # (o marrom inventado vira cinza-médio só com a conversão).
        x = ((luma - 0.12) / (0.85 - 0.12)).clamp(0, 1)
        luma = x * x * (3 - 2 * x)
        out = base_color.clone()
        out[..., :3] = luma.expand_as(rgb)
        print(f"[Trama] origem preto e branco (saturação {sat:.3f}): textura em tons de cinza")
        return (out,)


class TramaLimitMetallic:
    """Tira o metal da textura de um objeto escuro.

    Em personagem preto (desenho, roupa escura) o TRELLIS.2 entende "preto brilhante" e
    devolve o mapa de metal quase todo em 1: o modelo fica escuro como um espelho no
    visualizador. Com active ligado (saída dark do TramaContrastBackground), o metal
    é limitado ao valor de limit; com active desligado, o mapa passa sem mudança.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "metallic": ("IMAGE",),
                "active": ("BOOLEAN", {"default": True, "forceInput": True}),
                "limit": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("metallic",)
    FUNCTION = "limit_metal"
    CATEGORY = "Trama"

    def limit_metal(self, metallic, active, limit):
        if not active:
            return (metallic,)
        print(f"[Trama] objeto escuro: metal limitado a {limit}")
        return (metallic.clamp(max=float(limit)),)



class TramaVideoMask:
    """Máscara do personagem em cada quadro de um vídeo (remover fundo), em lotes.

    O Remove Background do ComfyUI manda todos os quadros ao modelo de uma vez; com um
    vídeo inteiro a GPU estoura (CUDA illegal memory access). Aqui vão poucos por vez e
    as máscaras ficam na CPU.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bg_removal_model": ("BACKGROUND_REMOVAL",),
                "images": ("IMAGE",),
                "batch": ("INT", {"default": 4, "min": 1, "max": 64, "tooltip": "Quadros por vez no modelo."}),
            }
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "mask"
    CATEGORY = "Trama"

    def mask(self, bg_removal_model, images, batch):
        import torch
        import comfy.utils
        out = []
        pbar = comfy.utils.ProgressBar(images.shape[0])
        for i in range(0, images.shape[0], batch):
            m = bg_removal_model.encode_image(images[i:i + batch])
            out.append(m.float().cpu())
            pbar.update(min(batch, images.shape[0] - i))
        return (torch.cat(out, dim=0),)


NODE_CLASS_MAPPINGS = {"TramaMatchVolume": TramaMatchVolume, "TramaAnalyzeAudio": TramaAnalyzeAudio, "TramaMixAudio": TramaMixAudio, "TramaAudioWindow": TramaAudioWindow, "TramaAceRepaint": TramaAceRepaint, "TramaRepaintSplice": TramaRepaintSplice, "TramaTranscribeAudio": TramaTranscribeAudio, "TramaLoadMesh": TramaLoadMesh, "TramaRiggedToGlb": TramaRiggedToGlb, "TramaContrastBackground": TramaContrastBackground, "TramaLimitMetallic": TramaLimitMetallic, "TramaImageStyle": TramaImageStyle, "TramaAnimate3D": TramaAnimate3D, "TramaMatchColor": TramaMatchColor, "TramaMotionToModel": TramaMotionToModel, "TramaVideoMask": TramaVideoMask}
NODE_DISPLAY_NAME_MAPPINGS = {"TramaMatchVolume": "Igualar volume (Trama)", "TramaAnalyzeAudio": "Analisar áudio (Trama)", "TramaMixAudio": "Juntar áudios (Trama)", "TramaAudioWindow": "Trecho para regerar (Trama)", "TramaAceRepaint": "Repaint do ACE-Step 1.5 (Trama)", "TramaRepaintSplice": "Colar trecho na música (Trama)", "TramaTranscribeAudio": "Transcrever voz (Trama)", "TramaLoadMesh": "Carregar modelo 3D (Trama)", "TramaRiggedToGlb": "Esqueleto: FBX para GLB (Trama)", "TramaContrastBackground": "Fundo com contraste para 3D (Trama)", "TramaLimitMetallic": "Limitar metal (Trama)", "TramaImageStyle": "Desenho chapado? (Trama)", "TramaAnimate3D": "Animar modelo 3D (Trama)", "TramaMatchColor": "Cor da textura igual à origem (Trama)", "TramaMotionToModel": "Movimento no modelo 3D (Trama)", "TramaVideoMask": "Máscara do vídeo em lotes (Trama)"}
