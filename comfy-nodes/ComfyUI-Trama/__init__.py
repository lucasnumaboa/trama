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

# Cabeça rígida: o UniRig aprendeu com proporção adulta e, em personagem cabeçudo (chibi,
# capacete grande), espalha o peso da cabeça entre Neck, Spine2 e ombros; a cabeça amassa
# quando o tronco se curva. Isto deixa a cabeça 100% no osso Head acima da junta, com uma
# transição curta com o Neck. Vértices puxados pelo braço (arma erguida, mão no rosto) e
# fora do raio da cabeça ficam como estão. Vai no começo dos scripts do Blender abaixo.
_RIGID_HEAD_PY = r'''
import bpy

_ARM_PARTS = ("Arm", "ForeArm", "Hand", "Thumb", "Index", "Middle", "Ring", "Pinky")


def _trama_name(n):
    n = n.split(":")[-1]
    return n[len("mixamorig"):] if n.startswith("mixamorig") else n


def _trama_bone(arm, name):
    return next((b for b in arm.data.bones if _trama_name(b.name) == name), None)


def _trama_is_arm(group_name):
    n = _trama_name(group_name)
    return (n.startswith("Left") or n.startswith("Right")) and "Shoulder" not in n and any(p in n for p in _ARM_PARTS)


def trama_fragments(o):
    """Pedaços da malha (a do TRELLIS é feita de pedaços soltos; o GLB ainda corta nas
    costuras da textura): vértices na mesma posição ligam os pedaços. Devolve {vértice: id}."""
    me = o.data
    key = {v.index: (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5)) for v in me.vertices}
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for p in me.polygons:
        r0 = find(key[p.vertices[0]])
        for i in p.vertices[1:]:
            ri = find(key[i])
            if ri != r0:
                parent[ri] = r0
    return {v: find(k) for v, k in key.items()}


def trama_skinned(objs):
    return [o for o in objs if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]


def trama_rigid_head(arm, meshes):
    """Devolve quantos vértices mudaram (0 se não há osso Head: esqueleto não humanoide)."""
    head, neck = _trama_bone(arm, "Head"), _trama_bone(arm, "Neck")
    if head is None or not meshes:
        return 0
    mw = arm.matrix_world
    P = mw @ head.head_local
    zs = [(o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices]
    H = max(zs) - min(zs)
    band = max(P.z - (mw @ neck.head_local).z if neck else 0.0, 0.02 * H)

    def info(o, v):
        tot = sum(g.weight for g in v.groups) or 1.0
        armw = sum(g.weight for g in v.groups if _trama_is_arm(o.vertex_groups[g.group].name)) / tot
        return o.matrix_world @ v.co, armw

    dists = sorted(((co.x - P.x) ** 2 + (co.y - P.y) ** 2) ** 0.5
                   for o in meshes for v in o.data.vertices for co, armw in [info(o, v)] if co.z > P.z and armw < 0.5)
    if not dists:
        return 0
    R = dists[int(0.97 * (len(dists) - 1))] * 1.1
    changed = 0
    for o in meshes:
        groups = o.vertex_groups
        hg = groups.get(head.name) or groups.new(name=head.name)
        ng = (groups.get(neck.name) or groups.new(name=neck.name)) if neck else None
        # Pedaço que é mais do braço (arma na mão encostada no capacete) fica com o braço inteiro.
        frag = trama_fragments(o)
        acc = {}
        for v in o.data.vertices:
            s_, n_ = acc.get(frag[v.index], (0.0, 0))
            acc[frag[v.index]] = (s_ + info(o, v)[1], n_ + 1)
        arm_frag = {k for k, (s_, n_) in acc.items() if s_ / n_ >= 0.5}
        for v in o.data.vertices:
            co, armw = info(o, v)
            if armw >= 0.5 or frag[v.index] in arm_frag or ((co.x - P.x) ** 2 + (co.y - P.y) ** 2) ** 0.5 > R:
                continue
            t = (co.z - (P.z - band)) / band
            if t <= 0:
                continue
            t = min(1.0, t)
            for g in list(v.groups):
                groups[g.group].remove([v.index])
            if ng is None or t >= 1.0:
                hg.add([v.index], 1.0, "REPLACE")
            else:
                hg.add([v.index], t, "REPLACE")
                ng.add([v.index], 1.0 - t, "REPLACE")
            changed += 1
        # Farelos: pedaço pequeno preso à cabeça mas fora do contorno dela (resto da "cortina"
        # entre a cabeça e uma arma encostada) fica flutuando ao lado do rosto: sai.
        hidx = groups.get(head.name).index
        stats = {}
        for v in o.data.vertices:
            co = o.matrix_world @ v.co
            hw = next((g.weight for g in v.groups if g.group == hidx), 0.0)
            s = stats.setdefault(frag[v.index], [0, 0.0, 0.0, 0.0])
            s[0] += 1
            s[1] += hw
            s[2] += ((co.x - P.x) ** 2 + (co.y - P.y) ** 2) ** 0.5
            s[3] = max(s[3], co.z)
        orphan = {k for k, (n_, hw_, d_, top_) in stats.items()
                  if n_ <= 400 and hw_ / n_ > 0.5 and d_ / n_ > R and top_ > P.z - band}
        if orphan:
            import bmesh
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bm.verts.ensure_lookup_table()
            dead = [f for f in bm.faces if all(frag[x.index] in orphan for x in f.verts)]
            bmesh.ops.delete(bm, geom=dead, context="FACES_ONLY")
            bm.to_mesh(o.data)
            bm.free()
            o.data.update()
    return changed
'''

# Malha que rasga: o TRELLIS funde partes que se encostam na imagem (arma encostada no
# capacete, mão na coxa). Depois do rig, os triângulos que ligam ossos longe um do outro
# esticam numa cortina quando as partes se afastam. Isto limpa pesos de ossos distantes,
# passa cada pedaço grudado para o osso que manda nele e descostura só a cortina pequena
# sobre um vão. Nada é apagado (apagar furava a malha).
_MESH_FIX_PY = r'''
import bpy


def _trama_hops(arm):
    """Distância em ossos entre dois ossos do esqueleto (pela árvore)."""
    parent = {b.name: (b.parent.name if b.parent else None) for b in arm.data.bones}

    def chain(n):
        out = []
        while n is not None:
            out.append(n)
            n = parent[n]
        return out

    cache = {}

    def hops(a, b):
        key = (a, b) if a < b else (b, a)
        if key not in cache:
            ca, cb = chain(a), chain(b)
            sb = {n: i for i, n in enumerate(cb)}
            cache[key] = next((i + sb[n] for i, n in enumerate(ca) if n in sb), 99)
        return cache[key]

    return hops


def trama_bridges(arm, meshes, min_hops=4, delete=False):
    """Acha (e se delete=True, apaga) os triângulos que ligam vértices cujo osso principal
    fica a min_hops ou mais ossos de distância (ex.: Hand e Head = 6). Devolve quantos."""
    import bmesh
    bone_names = {b.name for b in arm.data.bones}
    hops = _trama_hops(arm)
    total = 0
    for o in meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        main = {}
        for v in o.data.vertices:
            g = max((x for x in v.groups if names.get(x.group) in bone_names), key=lambda x: x.weight, default=None)
            main[v.index] = names[g.group] if g else None
        bad = []
        for p in o.data.polygons:
            bs = {main[i] for i in p.vertices if main[i]}
            if len(bs) < 2:
                continue
            bl = list(bs)
            if max(hops(a, b) for i, a in enumerate(bl) for b in bl[i + 1:]) >= min_hops:
                bad.append(p.index)
        total += len(bad)
        if delete and bad:
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[i] for i in bad], context="FACES_ONLY")
            bm.to_mesh(o.data)
            bm.free()
            o.data.update()
    return total


def trama_clean_weights(arm, meshes, max_hops=3):
    """Cada vértice fica só com os ossos a até max_hops do osso que mais pesa nele (um
    vértice da mão com peso também no quadril rasga quando a mão sobe). Devolve quantos mudaram."""
    bone_names = {b.name for b in arm.data.bones}
    hops = _trama_hops(arm)
    changed = 0
    for o in meshes:
        groups = o.vertex_groups
        names = {g.index: g.name for g in groups}
        for v in o.data.vertices:
            ws = [(names.get(g.group), g.group, g.weight) for g in v.groups if names.get(g.group) in bone_names and g.weight > 0]
            if len(ws) < 2:
                continue
            top = max(ws, key=lambda x: x[2])[0]
            drop = [(n, gi, w) for n, gi, w in ws if hops(top, n) > max_hops]
            if not drop:
                continue
            keep = [(n, gi, w) for n, gi, w in ws if hops(top, n) <= max_hops]
            tot = sum(w for _, _, w in keep) or 1.0
            for _, gi, _ in drop:
                groups[gi].remove([v.index])
            for _, gi, w in keep:
                groups[gi].add([v.index], w / tot, "REPLACE")
            changed += 1
    return changed


def trama_drop_crumbs(arm, meshes, min_hops=4, max_faces=300):
    """Pedaço solto pequeno (a malha do TRELLIS é feita de pedaços) que fica preso a ossos
    distantes também é ponte: estica quando as partes se afastam. Os pedaços são ligados
    pela posição dos vértices (o GLB corta a malha nas costuras da textura). Devolve quantas
    faces saíram."""
    import bmesh
    bone_names = {b.name for b in arm.data.bones}
    hops = _trama_hops(arm)
    total = 0
    for o in meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        main = {}
        for v in o.data.vertices:
            g = max((x for x in v.groups if names.get(x.group) in bone_names), key=lambda x: x.weight, default=None)
            main[v.index] = names[g.group] if g else None
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.faces.ensure_lookup_table()
        key = lambda v: (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5))
        parent = {}

        def find(a):
            while parent.setdefault(a, a) != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for f in bm.faces:
            ks = [key(v) for v in f.verts]
            r0 = find(ks[0])
            for k in ks[1:]:
                rk = find(k)
                if rk != r0:
                    parent[rk] = r0
        groups = {}
        for f in bm.faces:
            groups.setdefault(find(key(f.verts[0])), []).append(f)
        drop = []
        for g in groups.values():
            if len(g) > max_faces:
                continue
            bs = list({main[v.index] for f in g for v in f.verts if main[v.index]})
            if len(bs) > 1 and max(hops(a, b) for i, a in enumerate(bs) for b in bs[i + 1:]) >= min_hops:
                drop.extend(g)
        if drop:
            bmesh.ops.delete(bm, geom=drop, context="FACES_ONLY")
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
            bm.to_mesh(o.data)
            o.data.update()
        bm.free()
        total += len(drop)
    return total


def trama_settle_fragments(arm, meshes, min_hops=4, max_minority=0.35):
    """Sem furar a malha: num pedaço solto que ficou preso a ossos distantes (a malha do
    TRELLIS é feita de pedaços; o GLB ainda corta nas costuras da textura, então os pedaços
    se ligam pela posição dos vértices), a parte menor passa para o osso que manda no pedaço.
    O pedaço inteiro se move junto e nada estica. Devolve quantos vértices mudaram."""
    bone_names = {b.name for b in arm.data.bones}
    hops = _trama_hops(arm)
    changed = 0
    for o in meshes:
        groups = o.vertex_groups
        names = {g.index: g.name for g in groups}
        me = o.data
        key = {v.index: (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5)) for v in me.vertices}
        parent = {}

        def find(a):
            while parent.setdefault(a, a) != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for poly in me.polygons:
            r0 = find(key[poly.vertices[0]])
            for i in poly.vertices[1:]:
                ri = find(key[i])
                if ri != r0:
                    parent[ri] = r0
        frags = {}
        for v in me.vertices:
            frags.setdefault(find(key[v.index]), []).append(v)
        for vs in frags.values():
            tot = {}
            main = {}
            for v in vs:
                best = None
                for g in v.groups:
                    n = names.get(g.group)
                    if n in bone_names and g.weight > 0:
                        tot[n] = tot.get(n, 0.0) + g.weight
                        if best is None or g.weight > best[1]:
                            best = (n, g.weight)
                main[v.index] = best[0] if best else None
            if len(tot) < 2:
                continue
            dom = max(tot, key=tot.get)
            far = [v for v in vs if main[v.index] and hops(dom, main[v.index]) >= min_hops]
            if not far or len(far) > max_minority * len(vs):
                continue
            dg = groups.get(dom)
            for v in far:
                for g in list(v.groups):
                    groups[g.group].remove([v.index])
                dg.add([v.index], 1.0, "REPLACE")
                changed += 1
    return changed


def trama_split_seams(arm, meshes, min_hops=4):
    """Descostura (sem apagar nada) a emenda entre partes que se mexem separadas: cada
    triângulo fica do lado do osso que manda na maioria dos seus vértices, as arestas entre
    lados distantes no esqueleto são separadas (vértices duplicados) e cada cópia passa a
    seguir o lado dos seus triângulos. As duas partes se afastam sem esticar e sem furo.
    Devolve quantas arestas foram separadas."""
    import bmesh
    bone_names = {b.name for b in arm.data.bones}
    hops = _trama_hops(arm)
    total = 0
    for o in meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        idx = {n: i for i, n in names.items()}
        bm = bmesh.new()
        bm.from_mesh(o.data)
        dl = bm.verts.layers.deform.active
        if dl is None:
            bm.free()
            continue

        def main(v):
            d = v[dl]
            best = max(((names.get(k), w) for k, w in d.items() if names.get(k) in bone_names), key=lambda x: x[1], default=(None, 0))
            return best[0]

        # Só pontes sobre um vão: a cortina entre partes separadas (arma e capacete) tem uma
        # aresta longa ligando vértices de lados distantes no esqueleto. Onde as partes se
        # tocam (braço na barriga) essas arestas são curtas e a malha fica como está, porque
        # soltar ali levaria pedaços da barriga junto com o braço.
        lens = sorted(x.calc_length() for x in bm.edges)
        med = lens[len(lens) // 2] if lens else 0.0
        mains = {v: main(v) for v in bm.verts}
        seam = set()
        for f in bm.faces:
            for ed in f.edges:
                a, b = mains[ed.verts[0]], mains[ed.verts[1]]
                if a and b and a != b and hops(a, b) >= min_hops and ed.calc_length() > 2.5 * med:
                    seam.update(f.edges)
                    break
        side = {}
        for f in bm.faces:
            ms = [m for m in (mains[v] for v in f.verts) if m]
            side[f.index] = max(set(ms), key=ms.count) if ms else None
        seam = list(seam)
        # Emenda grande é contato de verdade (braço apoiado na barriga): descosturar ali leva
        # pedaços da barriga junto com o braço. Só a cortina pequena sobre um vão é solta.
        touched = {f for ed in seam for f in ed.link_faces}
        if len(touched) > 0.003 * max(1, len(bm.faces)):
            print('TRAMA_AVISO emenda grande (%d triângulos): não descosturei' % len(touched))
            seam = []
        if not seam:
            bm.free()
            continue
        fside = {f: side[f.index] for f in bm.faces}
        # normal suave de cada posição, para os vértices duplicados não ficarem facetados
        o.data.calc_normals_split() if hasattr(o.data, "calc_normals_split") else None
        smooth_n = {}
        for v in o.data.vertices:
            k = (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5))
            smooth_n[k] = smooth_n.get(k, v.normal * 0) + v.normal
        bmesh.ops.split_edges(bm, edges=seam)
        for v in bm.verts:
            ss = [fside.get(f) for f in v.link_faces if fside.get(f)]
            if not ss:
                continue
            s = max(set(ss), key=ss.count)
            m = main(v)
            if m and hops(m, s) >= min_hops:
                d = v[dl]
                for k in list(d.keys()):
                    del d[k]
                d[idx[s]] = 1.0
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()
        try:
            ns = []
            for v in o.data.vertices:
                n = smooth_n.get((round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5)))
                ns.append(n.normalized() if n is not None and n.length > 1e-9 else v.normal)
            o.data.normals_split_custom_set_from_vertices(ns)
        except Exception as err:
            print("TRAMA_AVISO normais:", err)
        total += len(seam)
    return total


def trama_fix_mesh(arm, meshes):
    """Limpa pesos de ossos distantes, assenta os pedaços grudados no osso que manda neles e
    descostura as emendas que sobraram. Nada é apagado. Devolve (pesos, pedaços, emendas)."""
    c = trama_clean_weights(arm, meshes)
    s = trama_settle_fragments(arm, meshes)
    e = trama_split_seams(arm, meshes)
    return c, s, e
'''

_BLENDER_SCRIPT = _RIGID_HEAD_PY + _MESH_FIX_PY + r'''
import sys, bpy
src, dst, dst_fbx, rigid = sys.argv[-4:]
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
if arms and rigid == "1":
    print("TRAMA_RIGID", trama_rigid_head(arms[0], trama_skinned(bpy.data.objects)))
if arms:
    print("TRAMA_MESHFIX", *trama_fix_mesh(arms[0], trama_skinned(bpy.data.objects)))
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_skins=True, export_animations=True, export_yup=True, export_image_format="AUTO")
# O FBX do Exportar sai daqui também, com os mesmos pesos do GLB.
bpy.ops.export_scene.fbx(filepath=dst_fbx, add_leaf_bones=False, path_mode="COPY", embed_textures=True)
arm = [o for o in bpy.data.objects if o.type == "ARMATURE"]
print("TRAMA_BONES", sum(len(a.data.bones) for a in arm))
'''

# Só a cabeça rígida num GLB com esqueleto (rigs feitos antes dela, antes do HY-Motion).
_RIGID_GLB_SCRIPT = _RIGID_HEAD_PY + _MESH_FIX_PY + r'''
import sys, bpy
src, dst = sys.argv[-2:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
n = trama_rigid_head(arm, trama_skinned(bpy.data.objects)) if arm else 0
print("TRAMA_RIGID", n)
fix = trama_fix_mesh(arm, trama_skinned(bpy.data.objects)) if arm else (0, 0, 0)
print("TRAMA_MESHFIX", *fix)
if n or any(fix):
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_skins=True, export_animations=True, export_yup=True)
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
    env["PYTHONIOENCODING"] = "utf-8"  # mensagens com acento chegam inteiras ao Trama
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


_ANIMATE_SCRIPT = _RIGID_HEAD_PY + _MESH_FIX_PY + r'''
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
# Rigs feitos antes da cabeça rígida também ganham (nos novos não muda nada).
print("TRAMA_RIGID", trama_rigid_head(arm, trama_skinned(bpy.data.objects)))
print("TRAMA_MESHFIX", *trama_fix_mesh(arm, trama_skinned(bpy.data.objects)))


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
    (0.50, dict(thighL=-5, thighR=-5, kneeL=0, kneeR=0, footL=-35, footR=-35, hips_up=0.12, lean=-4, swingL=120, swingR=120, elbowL=15, elbowR=15)),
    (0.75, dict(thighL=35, thighR=35, kneeL=70, kneeR=70, footL=10, footR=10, hips_up=0.45, lean=6, swingL=100, swingR=100, elbowL=25, elbowR=25)),
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


# Animação de criatura (esqueleto articulationxl do UniRig, ossos sem nome): as cadeias de
# ossos são separadas pela malha (pernas tocam o chão; asas são membranas largas em par;
# cauda fica atrás; braços saem do alto do corpo) e cada uma ganha seu movimento.
_CREATURE_SCRIPT = _MESH_FIX_PY + r'''
import sys, math, json, bpy
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
meshes = [o for o in bpy.data.objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]
# Sem a correção de malha dos humanoides: nos bichos testados (lobo, ogro) ela abriu buracos
# e soltou riscos nas patas, e sem ela a malha se move limpa.
bones = arm.data.bones
inv = arm.matrix_world.inverted()
UP = (inv.to_3x3() @ Vector((0, 0, 1))).normalized()
rad = math.radians

# ---- geometria (espaço da armadura) ----------------------------------------------
pts, owner = [], []  # ponto e o osso que mais pesa nele
for o in meshes:
    vs = o.data.vertices
    names = {g.index: g.name for g in o.vertex_groups}
    for v in list(vs)[:: max(1, len(vs) // 8000)]:
        pts.append(inv @ (o.matrix_world @ v.co))
        g = max(v.groups, key=lambda x: x.weight, default=None)
        owner.append(names.get(g.group) if g else None)
if not pts:
    print("TRAMA_ERROR o modelo não tem malha presa ao esqueleto.")
    sys.exit(2)
hgt = lambda p: p.dot(UP)
ground = min(hgt(p) for p in pts)
H = max(hgt(p) for p in pts) - ground
flat = lambda p: p - UP * hgt(p)
center = sum((flat(p) for p in pts), Vector()) / len(pts)

# ---- cadeias: de cada ponta até o osso onde o esqueleto se divide -------------------
def chain_to(leaf):
    c = [leaf]
    b = leaf
    while b.parent is not None and len(b.parent.children) == 1:
        b = b.parent
        c.insert(0, b)
    return c

def leaves_under(b):
    out, stack = [], [b]
    while stack:
        x = stack.pop()
        if x.children:
            stack.extend(x.children)
        else:
            out.append(x)
    return out

def path(a, leaf):
    """Ossos de a até a ponta (inclusive)."""
    c = [leaf]
    while c[0].name != a.name and c[0].parent is not None:
        c.insert(0, c[0].parent)
    return c

# Membros: cada ponta sobe até onde o esqueleto se divide; se tudo o que sai dali é curto
# (dedos, garras, dedos do pé, chifres, orelhas), sobe mais um trecho: mão, pé e cabeça
# viram um membro só com o braço, a perna ou o pescoço de onde saem.
def limb_root(leaf):
    c = chain_to(leaf)
    while c[0].parent is not None and c[0].parent.parent is not None:
        a = c[0].parent
        if max(sum(x.length for x in path(a, l)[1:]) for l in leaves_under(a)) < 0.2 * H:
            c = chain_to(a)
        else:
            break
    return c[0]

leaves = [b for b in bones if not b.children]
tip = lambda c: c[-1].tail_local
base = lambda c: c[0].head_local
length = lambda c: sum(b.length for b in c)
roots_ = []
for lf in leaves:
    r = limb_root(lf)
    if r not in roots_:
        roots_.append(r)
def inside(b, r):
    while b is not None:
        if b.name == r.name:
            return True
        b = b.parent
    return False
roots_ = [r for r in roots_ if not any(o.name != r.name and inside(r, o) for o in roots_)]
chains, LIMB = [], {}
for r in roots_:
    lv = leaves_under(r)
    low = min(lv, key=lambda l: hgt(l.tail_local))
    if hgt(low.tail_local) - ground < 0.12 * H:
        main = low  # perna: a ponta que toca o chão
    else:
        main = max(lv, key=lambda l: (l.tail_local - r.head_local).length)
    c = path(r, main)
    chains.append(c)
    LIMB[c[0].name] = {x.name for x in [r] + [y for l in lv for y in path(r, l)]}

def is_leg(c):
    drop = hgt(base(c)) - hgt(tip(c))
    reach = (flat(tip(c)) - flat(base(c))).length
    # toca o chão, desce bastante e é mais em pé do que deitada (cauda que encosta no chão não)
    return hgt(tip(c)) - ground < 0.12 * H and drop > 0.15 * H and reach < 0.9 * drop

legs = [c for c in chains if is_leg(c)]
leg_set = {b.name for c in legs for b in c}

# ---- para onde a criatura olha ------------------------------------------------------
F = (inv.to_3x3() @ Vector((0, -1, 0)))  # frente padrão do TRELLIS (olha para a câmera)
F = (F - UP * F.dot(UP)).normalized()
feet = [flat(tip(c)) for c in legs]
if len(feet) >= 4:
    # eixo longo dos pés = frente/trás; o lado da cabeça é o mais alto da malha
    m = sum(feet, Vector()) / len(feet)
    cov = [[sum((p - m)[i] * (p - m)[j] for p in feet) for j in range(3)] for i in range(3)]
    best, axis = -1, F
    for cand in (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)), Vector((1, 1, 0)).normalized(), Vector((1, -1, 0)).normalized()):
        cand = (cand - UP * cand.dot(UP))
        if cand.length < 1e-6:
            continue
        cand.normalize()
        var = sum(cand[i] * cand[j] * cov[i][j] for i in range(3) for j in range(3))
        if var > best:
            best, axis = var, cand
    for _ in range(20):  # iteração de potência para o eixo principal exato
        nv = Vector([sum(cov[i][j] * axis[j] for j in range(3)) for i in range(3)])
        nv = nv - UP * nv.dot(UP)
        if nv.length < 1e-9:
            break
        axis = nv.normalized()
    proj = sorted(p.dot(axis) for p in pts)
    a_lo, a_hi = proj[int(0.15 * len(proj))], proj[int(0.85 * len(proj))]
    top_hi = max((hgt(p) for p in pts if p.dot(axis) >= a_hi), default=0)
    top_lo = max((hgt(p) for p in pts if p.dot(axis) <= a_lo), default=0)
    F = axis if top_hi >= top_lo else -axis
elif len(feet) == 2:
    S0 = feet[1] - feet[0]
    if S0.length > 1e-6:
        cand = UP.cross(S0).normalized()
        F = cand if cand.dot(F) >= 0 else -cand
S = F.cross(UP).normalized()  # lado
L = max(p.dot(F) for p in pts) - min(p.dot(F) for p in pts)

def side_of(c):
    return 1 if (flat(tip(c)) - center).dot(S) >= 0 else -1

def spread(c):
    """Largura da malha presa à cadeia, em fração do comprimento: asa (membrana) é larga,
    braço e cauda são tubos finos."""
    names = LIMB.get(c[0].name) or {b.name for b in c}
    d = vec_of(c)
    if d.length < 1e-6:
        return 0.0
    d = d.normalized()
    o = base(c)
    r = sorted(((p - o) - d * (p - o).dot(d)).length for p, w in zip(pts, owner) if w in names)
    return r[int(0.9 * (len(r) - 1))] / max(1e-6, length(c)) if len(r) > 10 else 0.0

vec_of = lambda c: tip(c) - base(c)
base_f = lambda c: (flat(base(c)) - center).dot(F)
rest_chains = [c for c in chains if not (leg_set & {b.name for b in c})]
def wing_like(c):
    lat = abs((flat(tip(c)) - center).dot(S))
    rise = hgt(tip(c)) - hgt(base(c))
    return length(c) > 0.22 * H and lat > 0.25 * max(H, L) and hgt(base(c)) - ground > 0.35 * H and rise > -0.25 * H and spread(c) > 0.45

# Asas vêm em par: uma de cada lado, de tamanho parecido (um braço com arco grande não é asa).
cand = [c for c in rest_chains if wing_like(c)]
paired = [c for c in cand if any(side_of(o) != side_of(c) and 0.6 < length(o) / length(c) < 1.6 for o in cand if o is not c)]
wings, arms, tails, heads = [], [], [], []
for c in rest_chains:
    lat = abs((flat(tip(c)) - center).dot(S))
    fwd = (flat(tip(c)) - center).dot(F)
    rise = hgt(tip(c)) - hgt(base(c))
    if c in paired:
        wings.append(c)
    elif base_f(c) < -0.32 * L and fwd < -0.42 * L and fwd < base_f(c) and lat < 0.35 * max(H, L):
        tails.append(c)  # nasce na traseira e vai para trás (espinho nas costas nasce no meio)
    elif len(legs) < 4 and lat > 0.12 * H and hgt(tip(c)) < hgt(base(c)) + 0.05 * H and hgt(base(c)) - ground > 0.4 * H:
        arms.append(c)
    else:
        heads.append(c)
head = max(heads, key=lambda c: hgt(tip(c)) + 0.5 * (flat(tip(c)) - center).dot(F)) if heads else None
# Ponta curta no alto (chifre, orelha): quem acena é o osso de onde ela sai, o crânio.
HEADB = None
if head:
    HEADB = head[0] if length(head) > 0.12 * H or head[0].parent is None else head[0].parent
claimed = {b.name for g in (legs, wings, arms, tails) for c in g for b in c} | ({b.name for b in head} if head else set())
root = next(b for b in bones if b.parent is None)
spine = []
if HEADB:
    b = HEADB.parent
    while b is not None:
        if b.name not in claimed:
            spine.insert(0, b)
        b = b.parent

quad = len(legs) >= 4
summary = dict(legs=len(legs), wings=len(wings), arms=len(arms), tails=len(tails), head=bool(head), spine=len(spine), bones=len(bones),
               kind="quadrupede" if quad else "bipede" if len(legs) >= 2 else "sem pernas")
print("TRAMA_CREATURE " + json.dumps(summary))
print("TRAMA_CHAINS " + json.dumps([dict(n=len(c), len=round(length(c) / H, 2), spread=round(spread(c), 2), lat=round(abs((flat(tip(c)) - center).dot(S)) / H, 2)) for c in rest_chains]))

if motion == "fly" and not wings:
    print("TRAMA_ERROR este esqueleto não tem asas para voar (achei %d pernas, %d braços, %d caudas). Use walk, run, idle ou jump." % (len(legs), len(arms), len(tails)))
    sys.exit(2)
if motion in ("walk", "run", "jump") and len(legs) < 2:
    print("TRAMA_ERROR não achei pernas que tocam o chão neste esqueleto (achei %d). Use idle%s." % (len(legs), " ou fly" if wings else ""))
    sys.exit(2)

# ---- rotação em torno de um eixo da armadura, aplicada no osso -----------------------
def q(axis, deg):
    return Quaternion(axis, rad(deg))

def to_local(b, q_arm):
    m = b.matrix_local.to_3x3().normalized().to_quaternion()
    return m.inverted() @ q_arm @ m

def sign(v, axis, target):
    return 1 if (q(axis, 10) @ v).dot(target) > v.dot(target) else -1

# Sentidos de cada cadeia (calculados uma vez, na pose de repouso).
def vec(c):
    return tip(c) - base(c)

PITCH_UP = 1 if (q(S, 10) @ F).dot(UP) > F.dot(UP) else -1   # girar +θ em S levanta a frente
ROLL_UP = 1 if (q(F, 10) @ S).dot(UP) > S.dot(UP) else -1    # girar +θ em F levanta o lado +S

LEG = []
for c in legs:
    # Osso curto no começo (escápula, osso do quadril): a perna de verdade começa no próximo.
    J = c[1:] if len(c) >= 4 and c[0].length < 0.12 * length(c) else c
    fwd_part = (flat(tip(c)) - center).dot(F)
    LEG.append(dict(c=c, J=J, side=side_of(c), front=fwd_part > 0, pos=fwd_part,
                    swing=sign(vec(c), S, F),
                    knee=sign(J[1].tail_local - J[1].head_local, S, -F) if len(J) > 1 else 0))
WING = [dict(c=c, flap=sign(vec(c), F, UP), side=side_of(c)) for c in wings]

# Pernas por IK: cada pé segue um alvo (preso ao chão no apoio, em arco no passo) e o
# Blender dobra o joelho para o lado em que ele já dobra no modelo. Assim a pata da frente
# não dobra ao contrário, as patas não se cruzam e o pé não atravessa o chão.
# Como num rig de quadrúpede: o IK vai até o pulso/jarrete (cabeça do último osso, a pata) e a
# pata é guiada à parte por um segundo alvo: plana e parada no chão no apoio, dobrada no passo
# (a pata da frente dobra o pulso para trás; a de trás aponta os dedos para baixo). Com 5 ossos
# o primeiro é a escápula, que fica fora do IK e balança um pouco com o passo.
for d in LEG:
    J = d["J"]
    d["leg_h"] = max(1e-4, hgt(base(J)) - ground)            # altura da perna
    d["girdle"] = J[0] if len(J) >= 5 else None
    if len(J) >= 3 and quad:   # bípede (pé de gente, ogro) fica com o IK de antes
        d["paw"] = J[-1]
        d["ik"] = J[-2]
        d["chain"] = len(J) - 1 - (1 if d["girdle"] is not None else 0)
    else:
        d["paw"] = None
        d["ik"] = J[-1]
        d["chain"] = len(J)
    d["foot"] = d["ik"].tail_local.copy()                    # ponta do alvo, em repouso
    if d["paw"] is not None:
        pv = d["paw"].tail_local - d["paw"].head_local
        d["pawv"] = pv
        d["flex_s"] = sign(pv, S, -F)                        # girar + leva os dedos para trás
FEET = {}                                                    # perna -> deslocamento do alvo
FLEX = {}                                                    # perna -> dobra da pata (°)

def arm_rest(c):
    """Braço aberto em T (comum no modelo de origem): baixa até ~60° abaixo da horizontal."""
    v = vec(c).normalized()
    elev = math.degrees(math.asin(max(-1.0, min(1.0, v.dot(UP)))))
    if elev < -35:
        return Quaternion()
    need = 60 + elev
    sgn = 1 if (q(F, 10) @ v).dot(UP) < v.dot(UP) else -1
    return q(F, sgn * need)

ARM = []
for c in arms:
    # Clavícula: primeiro osso deitado, saindo do meio do peito. Girar o braço por ela leva o
    # ombro inteiro junto e rasga o peito (ogro). O giro vai no úmero (U[0]) e o cotovelo é U[1].
    v0 = c[0].tail_local - c[0].head_local
    lat0 = abs((flat(c[0].head_local) - center).dot(S))
    clav = len(c) >= 3 and abs(v0.normalized().dot(UP)) < 0.6 and lat0 < 0.18 * H
    U = c[1:] if clav else c
    uv = tip(c) - U[0].head_local
    v = uv.normalized()
    elev = math.degrees(math.asin(max(-1.0, min(1.0, v.dot(UP)))))
    rest = Quaternion()
    if elev >= -35:   # braço aberto em T: baixa até ~60° abaixo da horizontal
        sgn = 1 if (q(F, 10) @ v).dot(UP) < v.dot(UP) else -1
        rest = q(F, sgn * (60 + elev))
    rv = rest @ uv
    side_c = side_of(c)
    # girar +θ em F afasta a ponta do corpo? (abrir o braço para o lado)
    out = 1 if ((q(F, 10) @ rv).dot(S) * side_c) > (rv.dot(S) * side_c) else -1
    # cotovelo: dobrar para a frente (antebraço sobe à frente)
    elbow = sign(U[1].tail_local - U[1].head_local, S, F) if len(U) > 1 else 0
    ARM.append(dict(c=c, U=U, clav=c[0] if clav else None, side=side_c, rest=rest, swing=sign(rv, S, F), out=out, elbow=elbow))
print("TRAMA_ARMS " + json.dumps([dict(clav=bool(d["clav"]), n=len(d["U"])) for d in ARM]))

# Peito preso ao braço: o UniRig às vezes dá peso do úmero à pele do peito e da barriga, e
# qualquer balanço do braço puxa essa pele como uma cortina. Pele que fica mais perto do
# tronco (coluna e clavícula) do que dos ossos do braço passa para o tronco.
from mathutils.geometry import intersect_point_line

def seg_dist(p, b):
    h, t = b.head_local, b.tail_local
    c, k = intersect_point_line(p, h, t)
    if k < 0:
        c = h
    elif k > 1:
        c = t
    return (p - c).length

def torso_weights():
    if not ARM or not spine:
        return 0
    moved = 0
    torso = list(spine) + [d["clav"] for d in ARM if d["clav"] is not None]
    for d in ARM:
        # o braço inteiro abaixo do úmero (cotovelo, mão, dedos)
        sub = set()
        stack = [d["U"][0]]
        while stack:
            b = stack.pop()
            sub.add(b.name)
            stack.extend(b.children)
        segs = [b for b in d["U"][:3]]
        for o in meshes:
            idx = {g.name: g.index for g in o.vertex_groups}
            gname = {g.index: g.name for g in o.vertex_groups}
            vg = {g.name: g for g in o.vertex_groups}
            for v in o.data.vertices:
                ws = [(gname[g.group], g.weight) for g in v.groups if gname[g.group] in sub and g.weight > 0]
                if not ws:
                    continue
                p = inv @ (o.matrix_world @ v.co)
                da = min(seg_dist(p, b) for b in segs)
                tb = min(torso, key=lambda b: seg_dist(p, b))
                dt = seg_dist(p, tb)
                # dt < 0.8·da: pele do tronco (passa toda); 0,8..1,1: faixa de transição
                f = smooth((1.1 - dt / max(da, 1e-6)) / 0.3)
                if f <= 0:
                    continue
                tot = 0.0
                for n, w in ws:
                    vg[n].add([v.index], w * (1 - f), "REPLACE")
                    tot += w * f
                if tb.name not in vg:
                    vg[tb.name] = o.vertex_groups.new(name=tb.name)
                vg[tb.name].add([v.index], tot, "ADD")
                moved += 1
    return moved

def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)

print("TRAMA_TORSO %d" % torso_weights())

# Na emenda entre braço e corpo (braço encostado na barriga) o peso pula de um osso para o
# outro numa fileira de triângulos, que vira cortina quando o braço sai. Os pesos dessa faixa
# (e de duas voltas em torno) são alisados entre vizinhos: a pele estica aos poucos.
def band_smooth(iters=6, rings=2):
    if not ARM:
        return 0
    armset = set()
    for d in ARM:
        stack = [d["U"][0]]
        while stack:
            b = stack.pop(); armset.add(b.name); stack.extend(b.children)
    bone_names = {b.name for b in bones}
    n_band = 0
    for o in meshes:
        me = o.data
        gn = {g.index: g.name for g in o.vertex_groups}
        W = []
        for v in me.vertices:
            W.append({gn[g.group]: g.weight for g in v.groups if gn.get(g.group) in bone_names and g.weight > 0})
        dom = [max(w, key=w.get) if w else None for w in W]
        key = [(round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5)) for v in me.vertices]
        same = {}
        for i, k in enumerate(key):
            same.setdefault(k, []).append(i)
        nb = [set() for _ in me.vertices]
        for e in me.edges:
            a, b = e.vertices
            nb[a].add(b); nb[b].add(a)
        for grp in same.values():
            if len(grp) > 1:
                for i in grp:
                    nb[i].update(j for j in grp if j != i)
        band = set()
        for p in me.polygons:
            ins = [dom[i] in armset for i in p.vertices if dom[i]]
            if any(ins) and not all(ins):
                band.update(p.vertices)
        for _ in range(rings):
            band |= {j for i in band for j in nb[i]}
        n_band += len(band)
        for _ in range(iters):
            new = {}
            for i in band:
                acc = dict(W[i]); c = 1.0
                for j in nb[i]:
                    for n, w in W[j].items():
                        acc[n] = acc.get(n, 0.0) + w
                    c += 1
                tot = sum(acc.values()) or 1.0
                new[i] = {n: w / tot for n, w in acc.items() if w / tot > 0.01}
            for i, w in new.items():
                W[i] = w
        # cópias do mesmo ponto (costura da textura) ficam com o mesmo peso, senão a pele abre
        for grp in same.values():
            if len(grp) > 1 and any(i in band for i in grp):
                acc = {}
                for i in grp:
                    for n, w in W[i].items():
                        acc[n] = acc.get(n, 0.0) + w / len(grp)
                for i in grp:
                    W[i] = dict(acc)
                    band.add(i)
        vg = {g.name: g for g in o.vertex_groups}
        for i in band:
            for g in list(me.vertices[i].groups):
                if gn.get(g.group) in bone_names:
                    o.vertex_groups[g.group].remove([i])
            tot = sum(W[i].values()) or 1.0
            for n, w in W[i].items():
                if n not in vg:
                    vg[n] = o.vertex_groups.new(name=n)
                vg[n].add([i], w / tot, "REPLACE")
    return n_band

print("TRAMA_BAND %d" % band_smooth(iters=10))
TAIL = [dict(c=c) for c in tails]

# Fase de cada perna: quadrúpede anda em sequência lateral (traseira esq., dianteira esq.,
# traseira dir., dianteira dir.) e trota em diagonal; bípede alterna; mais pernas vão em ondas.
def leg_phase(i, gait):
    d = LEG[i]
    if quad and len(LEG) == 4:
        if gait == "walk":
            return {(1, False): 0.0, (1, True): 0.25, (-1, False): 0.5, (-1, True): 0.75}[(d["side"], d["front"])]
        return 0.0 if (d["side"] == 1) == d["front"] else 0.5
    same = sorted([j for j, e in enumerate(LEG) if e["side"] == d["side"]], key=lambda j: -LEG[j]["pos"])
    k = same.index(i)
    return (0.5 * (d["side"] < 0) + (0.5 if gait != "walk" else 0.25) * k) % 1.0

# duty = fração do ciclo com o pé no chão (andar ~0,65; trote/corrida < 0,5).
GAITS = {
    "walk": dict(T=1.1 if quad else 1.0, duty=0.65 if quad else 0.6, stride=0.30, step_h=0.16, swing=16 if quad else 22, lift=38, bob=0.010, vault=1,
                 roll=3.0, yaw=3.0, arm=12, tail=9, head=3.0, wing=5, wing_T=2.2),
    "run": dict(T=0.6 if quad else 0.7, duty=0.45 if quad else 0.4, stride=0.45, step_h=0.28, swing=26 if quad else 34, lift=70, bob=0.022, vault=-1,
                roll=4.0, yaw=4.0, arm=20, tail=14, head=4.0, wing=8, wing_T=1.2),
}

pose_bones = arm.pose.bones
for pb in pose_bones:
    pb.rotation_mode = "QUATERNION"
arm.animation_data_create()
arm.animation_data.action = bpy.data.actions.new(motion)

def add(rots, b, qa):
    rots[b.name] = qa @ rots.get(b.name, Quaternion())

def chain_rot(rots, c, axis, deg, falloff=1.0, lag=0.0, t=0.0, T=1.0):
    for k, b in enumerate(c):
        a = deg * (falloff ** k)
        if lag:
            a = deg * (falloff ** k) * math.sin(2 * math.pi * (t / T) - lag * k)
        add(rots, b, q(axis, a))

def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)

def step(u, duty):
    """Ângulo do passo (-1..1, + = pé na frente), quanto o pé está erguido (0..1) e quanto
    o corpo está sobre ele (0..1, 1 no meio do apoio)."""
    if u < duty:  # apoio: o pé vai para trás em ritmo constante
        s = u / duty
        return 1 - 2 * s, 0.0, math.cos(math.pi * (s - 0.5))
    s = (u - duty) / (1 - duty)  # balanço: volta rápido, em arco
    return -1 + 2 * smooth(s), math.sin(math.pi * s), 0.0

def gait_pose(rots, t, g, T):
    pel, che, nh, nf = 0.0, 0.0, 0, 0
    roll = 0.0
    theta = {}
    for i, d in enumerate(LEG):
        u = (t / T + leg_phase(i, motion)) % 1.0
        th, lift, load = step(u, g["duty"])
        theta[i] = th
        # metade do passo e altura do pé, em fração da altura da perna
        FEET[i] = F * (g["stride"] * d["leg_h"] * th) + UP * (g["step_h"] * d["leg_h"] * lift)
        # pata: o calcanhar sobe no fim do apoio, dobra no passo e abre de novo antes de pousar
        heel = max(0.0, (u - (g["duty"] - 0.12)) / 0.12) if g["duty"] - 0.12 < u < g["duty"] else 0.0
        FLEX[i] = (80 if (d["front"] and quad) else 50) * max(0.3 * heel, lift ** 0.7 if lift > 0 else 0.0)
        if d["girdle"] is not None:
            add(rots, d["girdle"], q(S, d["swing"] * (6 if motion == "walk" else 10) * th))
        if d["front"] and quad:
            che += load
            nf += 1
        else:
            pel += load
            nh += 1
        roll += -d["side"] * lift * (0 if (quad and d["front"]) else 1)
    pel = pel / max(1, nh)
    che = che / max(1, nf) if nf else pel
    v = g["vault"] * g["bob"] * H
    hp, hc = v * (pel - 0.5), v * (che - 0.5)
    pitch = math.degrees(math.atan2(hc - hp, 0.5 * max(L, 1e-6))) if quad else 0.0
    root_rot = q(S, PITCH_UP * pitch) @ q(F, ROLL_UP * g["roll"] * roll / max(1, nh))
    # coluna curva de leve para os lados, em S (frente e trás opostas)
    p = 2 * math.pi * t / T
    n = len(spine)
    for k, b in enumerate(spine):
        add(rots, b, q(UP, g["yaw"] * math.sin(p) * (1 if k >= n / 2 else -1) * 2 / max(1, n)))
    # braços: contra a perna do outro lado
    for d in ARM:
        opp = [theta[i] for i, e in enumerate(LEG) if e["side"] != d["side"]]
        a = -(sum(opp) / len(opp)) if opp else math.sin(p)
        add(rots, d["U"][0], q(S, d["swing"] * g["arm"] * a) @ d["rest"])
        if len(d["U"]) > 1:
            add(rots, d["U"][1], q(S, d["elbow"] * (12 + 10 * max(0.0, a))))
    for d in TAIL:
        chain_rot(rots, d["c"], UP, g["tail"], lag=0.8, t=t, T=T)
        chain_rot(rots, d["c"][:1], S, 0.4 * g["tail"] * math.sin(4 * math.pi * t / T - 1.0))
    for d in WING:
        add(rots, d["c"][0], q(F, d["flap"] * g["wing"] * math.sin(2 * math.pi * t / g["wing_T"])))
    if HEADB:
        # cabeça segura o olhar (desfaz a inclinação do corpo) e acena atrasada
        add(rots, HEADB, q(S, PITCH_UP * (-0.8 * pitch + g["head"] * math.sin(4 * math.pi * t / T - 1.2))))
    return UP * ((hp + hc) / 2), root_rot

def fly_pose(rots, t, T):
    # bate as asas, encolhe as pernas e flutua
    p = 2 * math.pi * t / T
    for d in WING:
        for k, b in enumerate(d["c"]):
            a = (38 if k == 0 else 22 * (0.8 ** k)) * math.sin(p - 0.6 * k)
            add(rots, b, q(F, d["flap"] * a))
    for d in LEG:
        J = d["J"]
        add(rots, J[0], q(S, -d["swing"] * 30))
        if len(J) > 1:
            add(rots, J[1], q(S, d["knee"] * 50))
    for d in ARM:
        add(rots, d["U"][0], q(S, d["swing"] * (15 + 10 * math.sin(p))) @ d["rest"])
    for d in TAIL:
        chain_rot(rots, d["c"], S, 6, lag=0.7, t=t, T=T)
    if HEADB:
        add(rots, HEADB, q(S, PITCH_UP * 3 * math.sin(p + 1)))
    return UP * (0.25 * H + 0.03 * H * math.sin(p + math.pi)), q(S, PITCH_UP * 2 * math.sin(p))

def idle_pose(rots, t, T):
    p = 2 * math.pi * t / T
    for i in range(len(LEG)):
        FEET[i] = Vector()
    for b in spine:
        add(rots, b, q(S, 1.5 * math.sin(p)))
    for d in ARM:
        add(rots, d["U"][0], q(S, d["swing"] * 3 * math.sin(p + 0.5)) @ d["rest"])
    for d in TAIL:
        chain_rot(rots, d["c"], UP, 8, lag=0.6, t=t, T=T)
    for d in WING:
        add(rots, d["c"][0], q(F, d["flap"] * 4 * math.sin(p)))
    if HEADB:
        add(rots, HEADB, q(UP, 8 * math.sin(p * 0.5)) @ q(S, PITCH_UP * 2 * math.sin(p + 1)))
    return UP * (0.004 * H * math.sin(p)), Quaternion()

# Pulo em fases: agacha jogando os braços para trás, impulso esticando com os braços para
# cima, encolhe no ar, estende as pernas para pousar, amortece e volta com um leve repique.
# up = altura (fração de H), flex = pernas dobradas, arms = braços (° para a frente; pouco no
# ombro e mais no cotovelo: braço encostado no corpo puxa a pele quando o ombro gira muito),
# lean = tronco para a frente (°), head = cabeça para cima (°), pitch = frente do bicho para cima (°).
JUMP = [
    (0.00, dict(up=0.0, flex=0.0, spread=0, arms=0, lean=0, head=0, pitch=0)),
    (0.30, dict(up=-0.10, flex=1.0, spread=0, arms=-12, lean=18, head=-6, pitch=-4)),
    (0.42, dict(up=0.03, flex=-0.15, spread=0, arms=18, lean=-6, head=8, pitch=12)),
    (0.66, dict(up=0.32, flex=0.75, spread=0, arms=22, lean=0, head=4, pitch=2)),
    (0.90, dict(up=0.10, flex=0.10, spread=0, arms=15, lean=4, head=0, pitch=-8)),
    (1.00, dict(up=-0.11, flex=1.0, spread=0, arms=6, lean=20, head=-8, pitch=-6)),
    (1.25, dict(up=0.015, flex=-0.05, spread=0, arms=-3, lean=-3, head=2, pitch=1)),
    (1.55, dict(up=0.0, flex=0.0, spread=0, arms=0, lean=0, head=0, pitch=0)),
]

def jump_pose(rots, t):
    k = JUMP[-1][1]
    for (t0, a), (t1, b) in zip(JUMP, JUMP[1:]):
        if t <= t1:
            x = smooth((t - t0) / max(1e-6, t1 - t0))
            k = {n: a[n] + (b[n] - a[n]) * x for n in a}
            break
    air = max(0.0, k["up"]) / 0.32
    for i, d in enumerate(LEG):
        tuck = max(0.0, k["flex"]) * air
        lift_up = max(0.0, k["up"]) * H + 0.35 * d["leg_h"] * tuck
        if quad:  # no ar a dianteira encolhe para a frente; a traseira estica para trás
            FEET[i] = UP * lift_up + F * ((0.25 if d["front"] else -0.30) * d["leg_h"] * air)
        else:
            FEET[i] = UP * lift_up
        FLEX[i] = (60 if (d["front"] and quad) else 35) * tuck
    for d in ARM:
        # para a frente e um pouco para fora: não cruza na frente do rosto
        add(rots, d["U"][0], q(S, d["swing"] * k["arms"]) @ q(F, d["out"] * k["spread"]) @ d["rest"])
        if len(d["U"]) > 1:   # cotovelo dobra mais quando o braço vai à frente
            add(rots, d["U"][1], q(S, d["elbow"] * (15 + 0.6 * max(0.0, k["arms"]))))
        if d["clav"] is not None:   # ombro sobe só um pouco
            add(rots, d["clav"], q(S, d["swing"] * 0.12 * max(0.0, k["arms"])))
    n = max(1, len(spine))
    qd = 0.35 if quad else 1.0   # bicho de quatro patas não dobra o tronco nem baixa a cabeça como gente
    for b in spine:
        add(rots, b, q(S, -PITCH_UP * qd * k["lean"] / n))
    if HEADB:
        add(rots, HEADB, q(S, PITCH_UP * (k["head"] if not quad else max(0.0, k["head"]))))
    for d in WING:
        add(rots, d["c"][0], q(F, d["flap"] * 30 * air * math.sin(t * 14)))
    for d in TAIL:
        chain_rot(rots, d["c"], S, PITCH_UP * 0.6 * k["lean"] - 10 * air)
    up = k["up"] * (0.6 if quad and k["up"] < 0 else 1.0)   # quadrúpede agacha menos
    return UP * (up * H), (q(S, PITCH_UP * (k["pitch"] if k["pitch"] > 0 else 0.5 * k["pitch"])) if quad else Quaternion())

if motion in GAITS:
    g = GAITS[motion]
    T = g["T"]
elif motion == "idle":
    T = 3.0
elif motion == "fly":
    T = 0.7
elif motion == "jump":
    T = JUMP[-1][0]
else:
    print("TRAMA_ERROR movimento desconhecido: " + motion)
    sys.exit(2)

loops = 1 if motion == "jump" else max(1, round(seconds / T))
frames = int(round(T * loops * FPS))
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 0, (frames if motion == "jump" else frames - 1)
root_m = root.matrix_local.to_3x3().normalized()

USE_IK = motion != "fly" and bool(LEG)
targets = {}
toes = {}
if USE_IK:
    for i, d in enumerate(LEG):
        e = bpy.data.objects.new("trama_pe_%d" % i, None)
        scene.collection.objects.link(e)
        e.location = arm.matrix_world @ d["foot"]
        targets[i] = e
        con = pose_bones[d["ik"].name].constraints.new("IK")
        con.target = e
        con.chain_count = d["chain"]
        con.use_tail = True
        if d["paw"] is not None:
            te = bpy.data.objects.new("trama_dedo_%d" % i, None)
            scene.collection.objects.link(te)
            toes[i] = te
            ct = pose_bones[d["paw"].name].constraints.new("DAMPED_TRACK")
            ct.target = te
            ct.track_axis = "TRACK_Y"

for f in range(scene.frame_start, scene.frame_end + 1):
    t = f / FPS
    rots = {}
    if motion in GAITS:
        offset, root_rot = gait_pose(rots, t, g, T)
    elif motion == "fly":
        offset, root_rot = fly_pose(rots, t, T)
    elif motion == "idle":
        offset, root_rot = idle_pose(rots, t, T)
    else:
        offset, root_rot = jump_pose(rots, t)
    rots[root.name] = root_rot @ rots.get(root.name, Quaternion())
    for name, qa in rots.items():
        pb = pose_bones[name]
        pb.rotation_quaternion = to_local(bones[name], qa)
        pb.keyframe_insert("rotation_quaternion", frame=f)
    rp = pose_bones[root.name]
    rp.location = root_m.inverted() @ offset
    rp.keyframe_insert("location", frame=f)
    for i, e in targets.items():
        e.location = arm.matrix_world @ (LEG[i]["foot"] + FEET.get(i, Vector()))
        e.keyframe_insert("location", frame=f)
    for i, te in toes.items():
        d = LEG[i]
        pv = q(S, d["flex_s"] * FLEX.get(i, 0.0)) @ d["pawv"]
        te.location = arm.matrix_world @ (d["foot"] + FEET.get(i, Vector()) + pv * 1.5)
        te.keyframe_insert("location", frame=f)

if USE_IK:
    # IK vira rotação comum nos ossos (o GLB e o FBX não levam o IK)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(frame_start=scene.frame_start, frame_end=scene.frame_end, only_selected=False, visual_keying=True,
                     clear_constraints=True, use_current_action=True, bake_types={"POSE"})
    bpy.ops.object.mode_set(mode="OBJECT")
    for e in list(targets.values()) + list(toes.values()):
        bpy.data.objects.remove(e, do_unlink=True)

arm["trama_front"] = list(arm.matrix_world.to_3x3() @ F)
bpy.ops.file.pack_all()
bpy.ops.export_scene.gltf(filepath=dst_glb, export_format="GLB", export_skins=True, export_animations=True, export_yup=True, export_force_sampling=True, export_extras=True)
bpy.ops.export_scene.fbx(filepath=dst_fbx, bake_anim=True, add_leaf_bones=False, path_mode="COPY", embed_textures=True)
print("TRAMA_ANIM", motion, frames, round(T * loops, 2), summary["kind"])
'''


def _is_humanoid_glb(path):
    """O GLB tem esqueleto humanoide (ossos do Mixamo)? Lê só o JSON do GLB, sem Blender."""
    import json
    import struct
    try:
        with open(path, "rb") as f:
            head = f.read(20)
            size = struct.unpack("<I", head[12:16])[0]
            doc = json.loads(f.read(size))
    except Exception:
        return True  # na dúvida, o caminho humanoide explica o que falta
    names = {str(n.get("name", "")).split(":")[-1].replace("mixamorig", "") for n in doc.get("nodes", [])}
    return {"Hips", "LeftUpLeg", "RightUpLeg", "LeftArm", "RightArm"} <= names


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
            },
            "optional": {
                "rigid_head": ("BOOLEAN", {"default": True, "tooltip": "Cabeça como um bloco (peso todo no osso Head): evita a cabeça amassar em personagem cabeçudo, chibi ou de capacete. Só vale para esqueleto humanoide (mixamo)."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("glb_path",)
    FUNCTION = "convert"
    OUTPUT_NODE = True
    CATEGORY = "Trama"
    DESCRIPTION = "Converte o FBX com esqueleto do UniRig em GLB (com ossos e pesos) e salva os dois na pasta output."

    def convert(self, fbx_output_path, filename_prefix, rigid_head=True):
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

        py = _blender_python()
        root = os.path.dirname(py)
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([root, os.path.join(root, "Library", "bin"), os.path.join(root, "Library", "mingw-w64", "bin"), os.path.join(root, "Scripts"), env.get("PATH", "")])
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(_BLENDER_SCRIPT)
            script = f.name
        try:
            r = subprocess.run([py, script, src, glb, fbx, "1" if rigid_head else "0"], env=env, capture_output=True, text=True, timeout=600, encoding="utf-8", errors="replace")
        finally:
            os.unlink(script)
        if r.returncode != 0 or not os.path.exists(glb):
            raise RuntimeError(f"O Blender não converteu o FBX: {(r.stderr or r.stdout)[-800:]}")
        if not os.path.exists(fbx):  # o card sai mesmo assim; o Exportar usa o FBX cru do UniRig
            shutil.copy(src, fbx)
        bones = next((l.split()[-1] for l in r.stdout.splitlines() if l.startswith("TRAMA_BONES")), "?")
        rigid = next((l.split()[-1] for l in r.stdout.splitlines() if l.startswith("TRAMA_RIGID")), "0")
        print(f"[Trama] GLB com esqueleto: {glb} ({bones} ossos, cabeça rígida em {rigid} vértices)")
        # Só o GLB é o resultado (vira o card); o FBX fica ao lado, com o mesmo nome, para o Exportar.
        files = [{"filename": os.path.basename(glb), "subfolder": subfolder, "type": "output"}]
        rel = os.path.relpath(glb, out_dir)
        return {"ui": {"3d": files, "text": [f"{bones} ossos"]}, "result": (rel,)}


# ---- Imagem para 3D: objeto escuro ------------------------------------------
class TramaAnimate3D:
    """Anima um modelo 3D com esqueleto: humanoide (template mixamo) ou criatura
    (template articulationxl: bicho, quadrúpede, monstro com ou sem asas).

    Não usa arquivos de animação de fora: monta o movimento direto nos ossos, quadro a
    quadro, no Blender do ambiente do UniRig. Humanoide: acha a frente pelos ossos do pé,
    baixa os braços da T-pose e gera andar, correr, parado ou pular. Criatura: separa as
    cadeias de ossos pela malha (pernas que tocam o chão, asas largas em par, cauda, cabeça,
    braços) e gera o passo do quadrúpede (sequência lateral; trote em diagonal), do bípede,
    bater de asas (fly), cauda e respiração. Salva GLB (o card) e FBX (Exportar).
    """

    MOTIONS = ["walk", "run", "jump", "idle", "fly"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("STRING", {"default": "3d/modelo_com_esqueleto.glb",
                                     "tooltip": "GLB com esqueleto (saída do workflow de esqueleto), dentro da pasta input."}),
                "motion": (cls.MOTIONS, {"default": "walk", "tooltip": "walk = andar, run = correr (trote no quadrúpede), jump = pular, idle = parado respirando, fly = voar batendo as asas (só criatura com asas)."}),
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
        creature = motion == "fly" or not _is_humanoid_glb(src)
        out = _run_blender(_CREATURE_SCRIPT if creature else _ANIMATE_SCRIPT, [src, glb, fbx, motion, str(seconds)])
        if not os.path.exists(glb):
            raise RuntimeError(f"O Blender não gerou a animação: {out[-800:]}")
        info = next((l for l in out.splitlines() if l.startswith("TRAMA_ANIM")), "")
        body = next((l[len("TRAMA_CREATURE "):] for l in out.splitlines() if l.startswith("TRAMA_CREATURE ")), "")
        if body:  # o que o Trama achou no esqueleto da criatura (pernas, asas, cauda)
            info = f"{info} {body}"
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
# Criatura (esqueleto articulationxl): a animação grava para onde ela olha.
saved_front = arm.get("trama_front") if arm else None
if saved_front is not None and len(saved_front) == 3:
    fv = Vector((saved_front[0], saved_front[1], 0))
    if fv.length > 1e-6:
        front = fv.normalized()
if arm and saved_front is None:
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
# Humanoide: de frente a 35° (mostra o rosto). Criatura: quase de lado, para ver o passo.
ang = math.radians(65 if saved_front is not None else 35)
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
        # Cabeça rígida antes do retarget (rigs feitos antes dela amassam a cabeça ao curvar).
        rigid_src = os.path.join(out_dir, tmp_rel, "rigid_" + os.path.basename(src))
        try:
            os.makedirs(os.path.dirname(rigid_src), exist_ok=True)
            if os.path.exists(rigid_src):
                os.remove(rigid_src)
            _run_blender(_RIGID_GLB_SCRIPT, [src, rigid_src], timeout=300)
            if os.path.exists(rigid_src):
                src = rigid_src
        except Exception as e:  # segue com o modelo como veio
            print(f"[Trama] cabeça rígida não aplicada: {e}")
        try:
            res = export_cls().export(motion_data, src, tmp_rel, "movimento", 0.0, 0.0)
        finally:
            if src == rigid_src and os.path.exists(rigid_src):
                os.remove(rigid_src)
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


def _sprite_cycle(alphas, n, skip, force_period):
    """Índices de n quadros num ciclo de movimento.

    O período sai da diferença entre a silhueta de cada quadro (alinhada pelos pés) e a
    do primeiro: o ciclo fecha no primeiro mínimo depois de passar por um máximo.
    """
    import numpy as np
    from PIL import Image

    def sil(a):
        ys, xs = np.nonzero(a)
        h, w = a.shape
        if len(xs) == 0:
            return np.zeros((96, 96), np.float32)
        cx, b = int(xs.mean()), int(ys.max())
        pad = np.zeros((h * 2, w * 2), np.float32)
        pad[h - b + h // 2: h - b + h // 2 + h, w - cx: w - cx + w] = a
        return np.asarray(Image.fromarray((pad * 255).astype(np.uint8)).resize((96, 96), Image.BOX), np.float32) / 255.0

    idx_all = list(range(min(skip, max(0, len(alphas) - n - 2)), len(alphas)))
    S = [sil(alphas[i]) for i in idx_all]
    d = np.array([np.abs(x - S[0]).mean() for x in S])
    period = None
    for p in range(6, len(S)):
        if d[p] < d[p - 1] and (p + 1 >= len(S) or d[p] <= d[p + 1]) and d[:p].max() > 2 * d[p]:
            period = p
            break
    if period is None:
        period = min(len(S) - 1, 16)
    if force_period:
        period = min(force_period, len(S) - 1)
    period = max(period, 1)
    return [idx_all[round(i * period / n)] for i in range(n)], period


def _sprite_pixel(cells, px_h, colors):
    """Pixel art: altura px_h, alfa binário, paleta comum a todos os quadros e contorno de 1 px."""
    from PIL import Image, ImageFilter, ImageChops
    cw, ch = cells[0].size
    pw, ph = max(1, round(cw * px_h / ch)), px_h
    small = [im.resize((pw, ph), Image.BOX) for im in cells]
    strip = Image.new("RGB", (pw * len(small), ph), (0, 0, 0))
    for k, im in enumerate(small):
        rgb = Image.new("RGB", im.size, (0, 0, 0))
        rgb.paste(im, mask=im.getchannel("A").point(lambda a: 255 if a > 110 else 0))
        strip.paste(rgb, (k * pw, 0))
    pal = strip.quantize(colors=colors + 1, method=Image.Quantize.MEDIANCUT)
    out = []
    for im in small:
        a = im.getchannel("A").point(lambda v: 255 if v > 110 else 0)
        q = im.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE).convert("RGBA")
        q.putalpha(a)
        edge = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(3)), a)
        res = Image.new("RGBA", q.size, (0, 0, 0, 0))
        res.paste(Image.new("RGBA", q.size, (20, 16, 24, 255)), mask=edge)
        res.paste(q, mask=a)
        out.append(res)
    return out


class TramaSpriteSheet:
    """Sprite sheet de um vídeo: escolhe um ciclo do movimento e monta folha, GIF e pixel art.

    Recebe os quadros do vídeo e a máscara do personagem (BiRefNet). Acha o período do
    ciclo pela silhueta, pega N quadros nele, alinha pelos pés (ou com recorte fixo, que
    mantém a altura do pulo) e grava: GIF, folha PNG com fundo transparente e, se pedido,
    a versão pixel art (GIF, folha 4x e folha 1x).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "mask": ("MASK",),
                "frames": ("INT", {"default": 8, "min": 2, "max": 32, "tooltip": "Quadros na folha."}),
                "skip_start": ("INT", {"default": 8, "min": 0, "max": 200, "tooltip": "Quadros do começo do vídeo ignorados (o movimento ainda está engrenando)."}),
                "cycle_frames": ("INT", {"default": 0, "min": 0, "max": 400, "tooltip": "Duração do ciclo em quadros do vídeo; 0 acha sozinho."}),
                "align": (["pés", "fixo"], {"default": "pés", "tooltip": "pés: alinha cada quadro pelos pés (andar, correr, parado). fixo: mesmo recorte em todos (pulo, para manter a altura)."}),
                "pixel_height": ("INT", {"default": 96, "min": 0, "max": 512, "tooltip": "Altura da pixel art em pixels; 0 não faz pixel art."}),
                "colors": ("INT", {"default": 24, "min": 2, "max": 255, "tooltip": "Cores da paleta da pixel art."}),
                "fps": ("INT", {"default": 10, "min": 1, "max": 60}),
                "filename_prefix": ("STRING", {"default": "trama/trama_sprite"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("sheet",)
    FUNCTION = "build"
    OUTPUT_NODE = True
    CATEGORY = "Trama"

    def build(self, images, mask, frames, skip_start, cycle_frames, align, pixel_height, colors, fps, filename_prefix):
        import os
        import numpy as np
        import torch
        import folder_paths
        from PIL import Image

        n_img = images.shape[0]
        if mask.shape[0] != n_img:
            raise RuntimeError(f"A máscara tem {mask.shape[0]} quadros e o vídeo {n_img}.")
        if n_img < frames + 2:
            raise RuntimeError(f"O vídeo tem só {n_img} quadros; precisa de mais que {frames + 2}.")
        if tuple(mask.shape[1:]) != tuple(images.shape[1:3]):
            mask = torch.nn.functional.interpolate(mask[:, None].float(), size=tuple(images.shape[1:3]), mode="bilinear")[:, 0]
        mask = mask.float().cpu()
        alphas = mask.numpy() > 0.4
        idx, period = _sprite_cycle(alphas, frames, skip_start, cycle_frames)
        print(f"[Trama] sprite: ciclo de {period} quadros, usando {idx}")

        def rgba(i):
            rgb = (images[i].cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            a = (mask[i].numpy() * 255).clip(0, 255).astype(np.uint8)
            a[a < 100] = 0
            return Image.fromarray(np.dstack([rgb, a]), "RGBA")

        ims = [rgba(i) for i in idx]
        if align == "fixo":
            box = None
            for i in idx:
                ys, xs = np.nonzero(alphas[i])
                if len(xs) == 0:
                    continue
                b = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
            if box is None:
                raise RuntimeError("Não achei o personagem no vídeo (máscara vazia).")
            box = (box[0] - 6, box[1] - 6, box[2] + 6, box[3] + 6)
            cells = [im.crop(box) for im in ims]
        else:
            feet = []
            box_w = box_h = 0
            for i in idx:
                ys, xs = np.nonzero(alphas[i])
                if len(xs) == 0:
                    raise RuntimeError("Não achei o personagem em algum quadro do ciclo (máscara vazia).")
                cx, b = int(xs.mean()), int(ys.max())
                feet.append((cx, b))
                box_w = max(box_w, 2 * max(cx - int(xs.min()), int(xs.max()) - cx) + 12)
                box_h = max(box_h, b - int(ys.min()) + 12)
            cells = [im.crop((cx - box_w // 2, b - box_h + 6, cx - box_w // 2 + box_w, b + 6)) for im, (cx, b) in zip(ims, feet)]

        out_dir = folder_paths.get_output_directory()
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
        os.makedirs(full_folder, exist_ok=True)
        stem = f"{filename}_{counter:05}_"
        made = []

        def save_gif(seq, name, scale=1):
            fr = []
            for im in seq:
                bg = Image.new("RGB", im.size, (235, 235, 235))
                bg.paste(im, (0, 0), im)
                if scale != 1:
                    bg = bg.resize((bg.width * scale, bg.height * scale), Image.NEAREST)
                fr.append(bg.convert("P", palette=Image.ADAPTIVE, colors=255))
            fr[0].save(os.path.join(full_folder, name), save_all=True, append_images=fr[1:],
                       duration=int(1000 / fps), loop=0, disposal=2)
            made.append(name)

        def save_sheet(seq, name, scale=1):
            cw, ch = seq[0].size
            sh = Image.new("RGBA", (cw * len(seq), ch), (0, 0, 0, 0))
            for k, im in enumerate(seq):
                sh.paste(im, (k * cw, 0))
            if scale != 1:
                sh = sh.resize((sh.width * scale, sh.height * scale), Image.NEAREST)
            sh.save(os.path.join(full_folder, name))
            made.append(name)
            return sh

        save_gif(cells, stem + ".gif")
        sheet = save_sheet(cells, stem + "folha.png")
        if pixel_height > 0:
            pix = _sprite_pixel(cells, pixel_height, colors)
            save_gif(pix, stem + "pixel.gif", scale=4)
            save_sheet(pix, stem + "pixel_folha_x4.png", scale=4)
            save_sheet(pix, stem + "pixel_folha.png")
        print(f"[Trama] sprite: {', '.join(made)} (célula {cells[0].size[0]}x{cells[0].size[1]})")
        files = [{"filename": f, "subfolder": subfolder, "type": "output"} for f in made]
        t = torch.from_numpy(np.asarray(sheet.convert("RGB"), np.float32) / 255.0)[None]
        return {"ui": {"images": files}, "result": (t,)}


NODE_CLASS_MAPPINGS = {"TramaMatchVolume": TramaMatchVolume, "TramaAnalyzeAudio": TramaAnalyzeAudio, "TramaMixAudio": TramaMixAudio, "TramaAudioWindow": TramaAudioWindow, "TramaAceRepaint": TramaAceRepaint, "TramaRepaintSplice": TramaRepaintSplice, "TramaTranscribeAudio": TramaTranscribeAudio, "TramaLoadMesh": TramaLoadMesh, "TramaRiggedToGlb": TramaRiggedToGlb, "TramaContrastBackground": TramaContrastBackground, "TramaLimitMetallic": TramaLimitMetallic, "TramaImageStyle": TramaImageStyle, "TramaAnimate3D": TramaAnimate3D, "TramaMatchColor": TramaMatchColor, "TramaMotionToModel": TramaMotionToModel, "TramaVideoMask": TramaVideoMask, "TramaSpriteSheet": TramaSpriteSheet}
NODE_DISPLAY_NAME_MAPPINGS = {"TramaMatchVolume": "Igualar volume (Trama)", "TramaAnalyzeAudio": "Analisar áudio (Trama)", "TramaMixAudio": "Juntar áudios (Trama)", "TramaAudioWindow": "Trecho para regerar (Trama)", "TramaAceRepaint": "Repaint do ACE-Step 1.5 (Trama)", "TramaRepaintSplice": "Colar trecho na música (Trama)", "TramaTranscribeAudio": "Transcrever voz (Trama)", "TramaLoadMesh": "Carregar modelo 3D (Trama)", "TramaRiggedToGlb": "Esqueleto: FBX para GLB (Trama)", "TramaContrastBackground": "Fundo com contraste para 3D (Trama)", "TramaLimitMetallic": "Limitar metal (Trama)", "TramaImageStyle": "Desenho chapado? (Trama)", "TramaAnimate3D": "Animar modelo 3D (Trama)", "TramaMatchColor": "Cor da textura igual à origem (Trama)", "TramaMotionToModel": "Movimento no modelo 3D (Trama)", "TramaVideoMask": "Máscara do vídeo em lotes (Trama)", "TramaSpriteSheet": "Sprite sheet do vídeo (Trama)"}
