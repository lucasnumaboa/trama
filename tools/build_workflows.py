"""Gera os workflows "trama_*" a partir dos templates oficiais do ComfyUI.

Para cada entrada de SPECS: copia o template, troca arquivos de modelo pelos
instalados, desliga (bypass) nós de LoRA que não existem aqui, ajusta valores,
põe uma nota em português para o agente e salva em user/default/workflows do
ComfyUI (sem sobrescrever arquivos existentes, a menos que --overwrite).

Uso: python tools/build_workflows.py <pasta dos templates> [--overwrite] [--only nome]
"""
import copy
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

COMFY = 'http://127.0.0.1:8188'

SPECS = [
    # ---- Criar imagem ----
    dict(out='trama_imagem_z_image_turbo', template='image_z_image_turbo', note="""## Criar imagem — Z-Image Turbo
Texto → imagem, rápido (8 passos) e fotorrealista, bom com texto escrito na imagem.
- **prompt** em inglês, detalhado. Tamanho padrão 1024x1024 (use múltiplos de 64; ex.: 768x1344 vertical, 1344x768 horizontal).
- Bom padrão para quase tudo: fotos, produtos, cenas, capas."""),
    dict(out='trama_imagem_qwen_image', template='image_qwen_image', bypass_files=['Qwen-Image-Lightning-8steps-V1.0.safetensors'],
         ksampler=dict(steps=20, cfg=2.5), note="""## Criar imagem — Qwen-Image
Texto → imagem com ótima aderência ao prompt e o melhor para **texto escrito** (cartazes, logos com letras, interfaces), inclusive em português.
- **prompt** detalhado; pode citar o texto exato entre aspas.
- Mais lento (20 passos). Tamanhos sugeridos: 1328x1328, 1664x928, 928x1664."""),
    dict(out='trama_imagem_flux2_klein', template='image_flux2_klein_text_to_image', swap={'flux-2-klein-4b.safetensors': 'flux-2-klein-4b-fp8.safetensors'},
         bypass_subgraph_files=['flux-2-klein-base-4b.safetensors'], note="""## Criar imagem — Flux.2 Klein 4B
Texto → imagem rápido (poucos passos), estética de alta qualidade, bom para ilustração e design.
- **prompt** em inglês. 1024x1024 padrão."""),
    dict(out='trama_imagem_ernie_turbo', template='image_ernie_image_turbo', note="""## Criar imagem — ERNIE Image Turbo
Texto → imagem rápido, bom com cenas e personagens, entende prompts em vários idiomas.
- **prompt** detalhado. Use quando quiser uma alternativa de estilo ao Z-Image."""),
    dict(out='trama_imagem_newbie', template='image_newbieimage_exp0_1-t2i', note="""## Criar imagem — NewBie (anime)
Texto → imagem focado em **anime e ilustração**.
- **prompt** em inglês, estilo tags (personagem, cabelo, roupa, cenário, iluminação)."""),
    # ---- Editar imagem ----
    dict(out='trama_editar_imagem_qwen_2_1', template='image_qwen_image_2_1_image_edit', drop_nodes=[472, 475], note="""## Editar imagem — Qwen Image 2.1
Edita uma imagem por instrução mantendo pessoas, rosto e enquadramento: trocar fundo, roupa, cor, objeto, estilo, texto escrito, pose.
- **Imagem 1** é a que será editada; o resultado sai no formato dela.
- **prompt**: a instrução em inglês, direta; cite a imagem como `<image1>` (ex.: "Replace the background of <image1> with a beach at sunset, keep the person unchanged").
- Para juntar duas fotos (duas pessoas, pessoa + produto), use o workflow trama_editar_imagem_qwen_2_1_referencia."""),
    dict(out='trama_editar_imagem_qwen_2_1_referencia', template='image_qwen_image_2_1_image_edit', drop_nodes=[472], note="""## Editar imagem com referência — Qwen Image 2.1 (duas imagens)
Monta uma imagem nova a partir de **duas** fotos: duas pessoas na mesma cena, pessoa vestindo a roupa da outra foto, produto na mão de alguém, logo aplicado num objeto.
- **Imagem 1** é a base (o resultado sai no formato dela); **Imagem 2** é a referência.
- **prompt** em inglês citando as fotos como `<image1>` e `<image2>`, dizendo o papel de cada uma e pedindo para manter rosto, cabelo e roupa (ex.: "<image1> and <image2> stand side by side at a churro cart, same faces and clothes as in their photos")."""),
    dict(out='trama_editar_imagem_qwen_2511', template='image_qwen_image_edit_2511_int8', note="""## Editar imagem — Qwen-Image-Edit 2511
Edita uma imagem por instrução: trocar fundo, roupa, cor, objeto, estilo, adicionar ou tirar elementos, mudar texto escrito, ajustar pose.
- **Imagem 1** é a que será editada; imagens extras (se houver entradas) servem de referência.
- **prompt**: a instrução, direta (ex.: "replace the background with a beach at sunset, keep the person unchanged")."""),
    dict(out='trama_editar_imagem_flux2_klein', template='image_flux2_klein_image_edit_4b_distilled', note="""## Editar imagem — Flux.2 Klein 4B (edição)
Edita imagem por instrução, rápido. Bom para variações de estilo e ajustes visuais.
- **prompt**: a instrução em inglês."""),
    # ---- Criar vídeo ----
    dict(out='trama_video_h3_texto', template='video_minimax_h3_t2v', note="""## Criar vídeo — MiniMax H3 (texto → vídeo, com som)
Gera vídeo **com áudio** só a partir do texto.
- **prompt** em inglês: cena, ação, câmera, som/fala. Duração e tamanho nos campos do workflow (múltiplos de 32)."""),
    dict(out='trama_video_h3_referencia', template='video_minimax_h3_r2v', note="""## Criar vídeo — MiniMax H3 (referências → vídeo, com som)
Gera vídeo usando **imagens, vídeos e áudios de referência** (personagem, objeto, cenário, voz).
- No prompt, cite as referências como `<Picture 1>`, `<Video 1>`, `<Audio 1>`.
- Bom para manter o mesmo personagem/produto em cenas novas."""),
    dict(out='trama_video_wan22_imagem', template='video_wan2_2_14B_i2v', note="""## Criar vídeo — Wan 2.2 14B (imagem → vídeo)
Anima uma imagem (sem som). Movimento natural e boa física; 4 passos com LoRA LightX2V.
- **prompt** em inglês descrevendo o movimento. Resolução baixa por padrão (rápido); suba com cuidado (24 GB)."""),
    dict(out='trama_video_wan22_quadros', template='video_wan2_2_14B_flf2v', note="""## Criar vídeo — Wan 2.2 14B (primeiro + último quadro)
Vídeo (sem som) que começa numa imagem e termina em outra. Mesma imagem nas duas = loop sem deformar.
- **prompt** em inglês descrevendo a transição/movimento."""),
    dict(out='trama_video_ltx23_texto', template='video_ltx2_3_t2v',
         swap={'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors': 'ltx-2.3-22b-distilled-lora-384.safetensors'},
         bypass_files=['gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors'], note="""## Criar vídeo — LTX-2.3 22B (texto → vídeo, com som)
Vídeo com áudio sincronizado a partir do texto, com etapa de ampliação 2x.
- **prompt** em inglês bem descritivo (cena, ação, câmera, sons, falas entre aspas)."""),
    dict(out='trama_video_ltx23_imagem', template='video_ltx2_3_i2v',
         swap={'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors': 'ltx-2.3-22b-distilled-lora-384.safetensors'},
         bypass_files=['gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors'], note="""## Criar vídeo — LTX-2.3 22B (imagem → vídeo, com som)
Anima uma imagem e gera o áudio junto.
- **prompt** em inglês com o movimento, a câmera e os sons."""),
    # ---- Música ----
    dict(out='trama_musica_ace_step_aio', template='audio_ace_step_1_5_checkpoint', note="""## Criar música — ACE-Step 1.5 Turbo (checkpoint único)
Música com voz e letra, mais leve que o XL.
- **tags**: estilo, instrumentos, voz, BPM (em inglês). **lyrics** com [verse]/[chorus]; `[instrumental]` para sem voz.
- **language** da letra (pt, en, es…). Duração no campo de segundos."""),
    # ---- Utilidades ----
    dict(out='trama_ampliar_imagem', template='utility-gan_upscaler', swap={'RealESRGAN_x4plus.safetensors': 'RealESRGAN_x4plus.pth'}, note="""## Ampliar imagem — RealESRGAN 4x
Aumenta a resolução em 4x mantendo nitidez. Troque o modelo para `4xNomosWebPhoto_RealPLKSR.pth` (fotos) ou `RealESRGAN_x2plus.pth` (2x)."""),
    dict(out='trama_remover_fundo', template='utility_birefnet_remove_background', preview_to_save=True, note="""## Remover fundo — BiRefNet
Recorta o objeto/pessoa e deixa o fundo transparente (PNG)."""),
]

MODEL_EXT = ('.safetensors', '.pth', '.ckpt', '.gguf')


def all_nodes(w):
    yield from w['nodes']
    for sg in (w.get('definitions') or {}).get('subgraphs', []):
        yield from sg['nodes']


def build(spec, tdir):
    w = json.load(open(f"{tdir}/{spec['template']}.json", encoding='utf-8'))
    swap = spec.get('swap', {})
    # Remove nós do nível de cima (ex.: comparação lado a lado, segunda imagem) e os links deles.
    drop = set(spec.get('drop_nodes', []))
    if drop:
        w['nodes'] = [n for n in w['nodes'] if n['id'] not in drop]
        gone = {l[0] for l in w['links'] if l[1] in drop or l[3] in drop}
        w['links'] = [l for l in w['links'] if l[0] not in gone]
        for n in w['nodes']:
            for i in n.get('inputs') or []:
                if i.get('link') in gone:
                    i['link'] = None
            for o in n.get('outputs') or []:
                if o.get('links'):
                    o['links'] = [l for l in o['links'] if l not in gone]
    for n in all_nodes(w):
        wv = n.get('widgets_values')
        if isinstance(wv, list):
            n['widgets_values'] = [swap.get(v, v) if isinstance(v, str) else v for v in wv]
            if any(isinstance(v, str) and v in spec.get('bypass_files', []) for v in wv):
                n['mode'] = 4
            if n['type'] == 'KSampler' and spec.get('ksampler'):
                # [seed, control, steps, cfg, sampler, scheduler, denoise]
                if 'steps' in spec['ksampler']: n['widgets_values'][2] = spec['ksampler']['steps']
                if 'cfg' in spec['ksampler']: n['widgets_values'][3] = spec['ksampler']['cfg']
            if n['type'].startswith('Save') and wv and isinstance(wv[0], str) and n['type'] not in ('SaveLatent',):
                n['widgets_values'][0] = f"trama/{spec['out']}"
    # Template que só mostra prévia (arquivo temporário): passa a salvar de verdade.
    if spec.get('preview_to_save'):
        for n in w['nodes']:
            if n['type'] == 'PreviewImage':
                n['type'] = 'SaveImage'
                n['widgets_values'] = [f"trama/{spec['out']}"]
                n.setdefault('properties', {})['Node name for S&R'] = 'SaveImage'
    # Desliga instâncias de subgrafo que usam arquivos inexistentes.
    if spec.get('bypass_subgraph_files'):
        subs = {sg['id']: sg for sg in (w.get('definitions') or {}).get('subgraphs', [])}
        bad = {sid for sid, sg in subs.items() if any(isinstance(v, str) and v in spec['bypass_subgraph_files'] for nd in sg['nodes'] for v in (nd.get('widgets_values') or []) if isinstance(nd.get('widgets_values'), list))}
        for n in w['nodes']:
            if n['type'] in bad:
                n['mode'] = 2  # mudo: nem roda, nem repassa
                # e muta as saídas ligadas só a ele (Save/Preview)
                out_links = {l for o in n.get('outputs', []) for l in (o.get('links') or [])}
                for m in w['nodes']:
                    if any(i.get('link') in out_links for i in m.get('inputs', [])) and m['type'].startswith(('Save', 'Preview')):
                        m['mode'] = 2
    # Nota em português (substitui as notas do template).
    w['nodes'] = [n for n in w['nodes'] if n['type'] not in ('MarkdownNote', 'Note')]
    nid = max(n['id'] for n in w['nodes']) + 1
    xs = [n['pos'][0] for n in w['nodes']]
    ys = [n['pos'][1] for n in w['nodes']]
    w['nodes'].append({'id': nid, 'type': 'MarkdownNote', 'title': 'Como usar', 'pos': [min(xs) - 520, min(ys)], 'size': [460, 360], 'flags': {}, 'order': 0, 'mode': 0,
                       'inputs': [], 'outputs': [], 'properties': {}, 'widgets_values': [spec['note'].strip()], 'color': '#432', 'bgcolor': '#653'})
    w['last_node_id'] = max(w.get('last_node_id', 0), nid)
    return w


def save(name, w, overwrite):
    body = json.dumps(w, ensure_ascii=False).encode('utf-8')
    path = urllib.parse.quote(f'workflows/{name}.json', safe='')
    req = urllib.request.Request(f'{COMFY}/api/userdata/{path}?overwrite={"true" if overwrite else "false"}', data=body, method='POST', headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=30)
        return 'salvo'
    except urllib.error.HTTPError as e:
        return 'já existe' if e.code == 409 else f'erro HTTP {e.code}'


if __name__ == '__main__':
    tdir = sys.argv[1]
    overwrite = '--overwrite' in sys.argv
    only = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else None
    for spec in SPECS:
        if only and spec['out'] != only:
            continue
        try:
            print(f"{spec['out']:34} {save(spec['out'], build(spec, tdir), overwrite)}")
        except Exception as e:
            print(f"{spec['out']:34} ERRO {e}")
