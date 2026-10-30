#!/usr/bin/env python3
"""Montage du tutoriel : transforme les prises de vues du site (shoot.mjs) en vidéo verticale 720 x 1280, 30 images par seconde.

Entrée : <dossier>/manifest.json + stills/*.jpg (images fixes du site) + clips/*.mp4 (le vrai extrait, rendu par le studio) ;
sortie : un MP4 avec musique. Tout le mouvement est calculé ici, image par image, donc fluide : curseur, zoom de caméra, anneau autour du
bouton, ondes de clic, fondus entre l'avant et l'après d'un clic, extrait qui se joue dans l'écran du téléphone, légendes et progression.
"""
import argparse, bisect, json, math, os, subprocess, sys, tempfile, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.environ.get('TUTORIAL_ROOT') or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
FPS = 30
W, H = 720, 1280
CARD = (20, 20, 680, 1000)        # carte qui montre le site : x, y, largeur, hauteur
PANEL_Y = 1040                    # début de la zone des légendes
BLUE, DARK, PINK, CHAMOIS, WHITE = (29, 37, 122), (15, 23, 82), (208, 22, 95), (222, 219, 189), (255, 255, 255)
INTRO_S, OUTRO_S = 2.2, 2.4
CLIP_MAX = 3.4                    # durée maximale de lecture de l'extrait dans le téléphone

def clamp(v, lo, hi): return max(lo, min(hi, v))
def ease(u):
    u = clamp(u, 0, 1)
    return 4 * u * u * u if u < 0.5 else 1 - pow(-2 * u + 2, 3) / 2
def ease_out(u): return 1 - pow(1 - clamp(u, 0, 1), 3)
def ease_back(u):
    u = clamp(u, 0, 1)
    c1, c3 = 1.4, 2.4
    return 1 + c3 * pow(u - 1, 3) + c1 * pow(u - 1, 2)

def font(name, size): return ImageFont.truetype(os.path.join(a.fonts, name), size)

class Camera:
    """Caméra : suite de mouvements (instant, centre x, centre y, zoom, durée) ; chacun part de l'état atteint à cet instant."""
    def __init__(self, base=(180, 265, 1.0)):
        self.base, self.segs = base, []
    def to(self, t, cx, cy, z, dur):
        cur = self.at(t) if self.segs else self.base
        self.segs.append((t, t + dur, cur, (cx, cy, z)))
    def at(self, s):
        cur = self.base
        for t0, t1, a0, a1 in self.segs:
            if s < t0: break
            e = ease(1.0 if t1 <= t0 else (s - t0) / (t1 - t0))
            cur = tuple(a0[i] + (a1[i] - a0[i]) * e for i in range(3))
        return cur

# ------------------------------------------------------------------ curseur, ondes, légendes
def make_cursor(scale=4):
    s = scale
    w, h = 34 * s, 42 * s
    im = Image.new('RGBA', (w + 20 * s, h + 20 * s), (0, 0, 0, 0))
    pts = [(3, 2), (3, 28), (9.5, 22), (14.5, 33.5), (19.8, 31), (14.8, 19.8), (23.5, 19.8)]
    poly = [(10 * s + x * s, 8 * s + y * s) for x, y in pts]
    sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 2 * s, y + 4 * s) for x, y in poly], fill=(0, 0, 0, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(3 * s))
    im.alpha_composite(sh)
    d = ImageDraw.Draw(im)
    d.polygon(poly, fill=(255, 255, 255, 255), outline=DARK + (255,), width=int(2.2 * s))
    d.line(poly + [poly[0]], fill=DARK + (255,), width=int(2.4 * s), joint='curve')
    tip = (10 * s + 3 * s, 8 * s + 2 * s)
    return im, tip, s

def wrap(text, fnt, width):
    words, lines, cur = text.split(), [], ''
    for w_ in words:
        t = (cur + ' ' + w_).strip()
        if fnt.getlength(t) <= width: cur = t
        else:
            lines.append(cur); cur = w_
    if cur: lines.append(cur)
    return lines

def caption_layer(num, title, hint, total):
    """Légende : barre de progression, pastille du numéro, titre, aide (RGBA, hauteur H - PANEL_Y)."""
    S = 2
    ph = H - PANEL_Y
    im = Image.new('RGBA', (W * S, ph * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # progression
    gap, left = 8, 36
    seg = (W - 2 * left - gap * (total - 1)) / total
    for i in range(total):
        x0 = left + i * (seg + gap)
        col = PINK + (255,) if i + 1 == num else (WHITE + (235,) if i + 1 < num else WHITE + (60,))
        d.rounded_rectangle([x0 * S, 4 * S, (x0 + seg) * S, 12 * S], radius=4 * S, fill=col)
    # pastille
    bx, by, bd = left, 44, 84
    d.ellipse([bx * S, by * S, (bx + bd) * S, (by + bd) * S], fill=PINK + (255,))
    fb = font('montserrat.ttf', 50 * S)
    tw = fb.getlength(str(num))
    d.text(((bx + bd / 2) * S - tw / 2, (by + bd / 2) * S), str(num), font=fb, fill=WHITE, anchor='lm')
    # titre
    tx = bx + bd + 26
    maxw = W - tx - 30
    size = 48
    ft = font('montserrat.ttf', size * S)
    while ft.getlength(title) > maxw * S and size > 34:
        size -= 2
        ft = font('montserrat.ttf', size * S)
    lines = wrap(title, ft, maxw * S)[:2]
    ty = by + bd / 2 - (len(lines) - 1) * size * 0.55
    for i, ln in enumerate(lines):
        d.text((tx * S, (ty + i * size * 1.1) * S), ln, font=ft, fill=WHITE, anchor='lm')
    # aide
    fh = font('inter.ttf', 28 * S)
    hl = wrap(hint, fh, (W - 2 * left) * S)[:3]
    for i, ln in enumerate(hl):
        d.text((left * S, (by + bd + 30 + i * 38) * S), ln, font=fh, fill=CHAMOIS + (255,), anchor='lm')
    return im.resize((W, ph), Image.LANCZOS)

def gradient():
    arr = np.zeros((H, W, 3), dtype=np.float32)
    t = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    for c in range(3): arr[:, :, c] = (BLUE[c] * (1 - t) + DARK[c] * t)
    bg = Image.fromarray(arr.astype(np.uint8)).convert('RGBA')
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    od.polygon([(0, 0), (260, 0), (0, 520)], fill=(255, 255, 255, 14))
    od.polygon([(W, 380), (W, 1280), (200, 1280)], fill=(255, 255, 255, 10))
    return Image.alpha_composite(bg, ov)

def backdrop():
    """Fond : dégradé bleu du site, avec les bandes en diagonale du bandeau, et l'ombre de la carte."""
    bg = gradient()
    x, y, w, h = CARD
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x - 2, y + 10, x + w + 2, y + h + 14], radius=34, fill=(0, 0, 0, 150))
    sh = sh.filter(ImageFilter.GaussianBlur(14))
    return Image.alpha_composite(bg, sh).convert('RGB')

def card_mask():
    S = 3
    m = Image.new('L', (CARD[2] * S, CARD[3] * S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, CARD[2] * S - 1, CARD[3] * S - 1], radius=30 * S, fill=255)
    return m.resize((CARD[2], CARD[3]), Image.LANCZOS)

# ------------------------------------------------------------------ cartes d'introduction et de conclusion
def banner_bg(o):
    bg = gradient()
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    sh = 30 * math.sin(o * 1.4)
    od.polygon([(0 + sh, 0), (360 + sh, 0), (0 + sh, 760)], fill=(255, 255, 255, 18))
    od.polygon([(W, 500 - sh), (W, 1280), (260 - sh, 1280)], fill=(255, 255, 255, 14))
    return Image.alpha_composite(bg, ov)

def centered(d, text, fnt, y, fill, S=1, x=W // 2):
    d.text((x * S, y * S), text, font=fnt, fill=fill, anchor='mm')

def intro_frame(o, cfg, logo):
    S = 1
    im = banner_bg(o)
    d = ImageDraw.Draw(im)
    u_logo = ease_out(o / 0.6)
    lg = logo.resize((int(logo.width * 1.5), int(logo.height * 1.5)), Image.LANCZOS)
    lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    lay.alpha_composite(lg, (W // 2 - lg.width // 2, int(250 - 40 * (1 - u_logo))))
    lay.putalpha(lay.getchannel('A').point(lambda v: int(v * u_logo)))
    im.alpha_composite(lay)
    words = cfg['intro'][0]
    f1, f2 = font('montserrat.ttf', 92), font('montserrat.ttf', 100)
    for i, (txt, col, fnt, y) in enumerate([(words[0], WHITE, f1, 640), (words[1], CHAMOIS, f2, 760)]):
        u = ease_out((o - 0.35 - 0.2 * i) / 0.5)
        if u > 0:
            tmp = Image.new('RGBA', im.size, (0, 0, 0, 0))
            ImageDraw.Draw(tmp).text((W // 2, y + 40 * (1 - u)), txt, font=fnt, fill=col + (int(255 * u),), anchor='mm')
            im.alpha_composite(tmp)
    u = ease_out((o - 1.0) / 0.5)
    if u > 0:
        tmp = Image.new('RGBA', im.size, (0, 0, 0, 0))
        td = ImageDraw.Draw(tmp)
        pill = font('montserrat.ttf', 34)
        txt = cfg['intro'][1]
        wpx = pill.getlength(txt) + 70
        y = 930 + 20 * (1 - u)
        td.rounded_rectangle([W // 2 - wpx / 2, y - 36, W // 2 + wpx / 2, y + 36], radius=36, fill=PINK + (int(255 * u),))
        td.text((W // 2, y), txt, font=pill, fill=WHITE + (int(255 * u),), anchor='mm')
        sub = font('inter.ttf', 32)
        td.text((W // 2, y + 90), cfg['intro'][2], font=sub, fill=CHAMOIS + (int(255 * u),), anchor='mm')
        im.alpha_composite(tmp)
    return im.convert('RGB')

def outro_frame(o, cfg, logo):
    im = banner_bg(o + 5)
    d = ImageDraw.Draw(im)
    u = ease_out(o / 0.5)
    f1 = font('montserrat.ttf', 100)
    tmp = Image.new('RGBA', im.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    td.text((W // 2, 450 + 40 * (1 - u)), cfg['outro'][0], font=f1, fill=WHITE + (int(255 * u),), anchor='mm')
    td.text((W // 2, 570 + 40 * (1 - u)), cfg['outro'][1], font=font('montserrat.ttf', 100), fill=CHAMOIS + (int(255 * u),), anchor='mm')
    u2 = ease_out((o - 0.5) / 0.5)
    if u2 > 0:
        pill = font('montserrat.ttf', 40)
        txt = cfg['outro'][2]
        wpx = pill.getlength(txt) + 90
        y = 780 + 20 * (1 - u2)
        td.rounded_rectangle([W // 2 - wpx / 2, y - 46, W // 2 + wpx / 2, y + 46], radius=46, fill=PINK + (int(255 * u2),))
        td.text((W // 2, y), txt, font=pill, fill=WHITE + (int(255 * u2),), anchor='mm')
        td.text((W // 2, y + 110), cfg['outro'][3], font=font('inter.ttf', 32), fill=CHAMOIS + (int(255 * u2),), anchor='mm')
    im.alpha_composite(tmp)
    u3 = ease_out((o - 0.2) / 0.6)
    lg = logo.resize((int(logo.width * 1.2), int(logo.height * 1.2)), Image.LANCZOS)
    lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    lay.alpha_composite(lg, (W // 2 - lg.width // 2, 1010))
    lay.putalpha(lay.getchannel('A').point(lambda v: int(v * u3)))
    im.alpha_composite(lay)
    return im.convert('RGB')

# ------------------------------------------------------------------ déroulé : scènes -> événements datés
def build(manifest):
    vp = manifest['viewport']
    ev = dict(states=[], moves=[], clicks=[], rings=[], clips=[], caps=[], cuts=[], starts=[])
    cam = Camera((vp['width'] / 2, vp['height'] * 0.37, 1.0))
    cursor = (vp['width'] * 0.72, vp['height'] * 0.93)
    t = 0.0
    first = True
    for sc in manifest['scenes']:
        files = sc['states']
        ev['starts'].append(t); ev['cuts'].append(t)
        ev['caps'].append((t, dict(num=sc['num'], title=sc['title'], hint=sc['hint'])))
        ev['states'].append((t, files[0], 0.0 if first else 0.42, 'wipe'))
        first = False
        cam.to(t, vp['width'] / 2, vp['height'] * 0.37, 1.0, 0.5)
        t += 0.7
        for op in sc['ops']:
            k = op['op']
            if k == 'click':
                r = op['target']
                tx, ty = r['x'] + r['w'] / 2, r['y'] + r['h'] / 2
                dist = math.hypot(tx - cursor[0], ty - cursor[1])
                dur = clamp(0.5 + dist / 800, 0.6, 1.05)
                cam.to(t, tx, ty - 10, 1.35 if r['w'] < 300 else 1.2, 0.8)
                ev['rings'].append((t, t + dur + 0.25, r))
                ev['moves'].append((t, dur, cursor, (tx, ty)))
                cursor = (tx, ty)
                t += dur + 0.16
                ev['clicks'].append((t, tx, ty))
                t += 0.07
                if op['to'] is not None: ev['states'].append((t, files[op['to']], 0.2, 'fade'))
                t += 0.55
            elif k == 'clip':
                p = op['phone']
                frames_dir = op['frames_dir']
                n = len(os.listdir(frames_dir))
                dur = min(CLIP_MAX, n / FPS)
                cam.to(t, p['x'] + p['w'] / 2, p['y'] + p['h'] / 2, 1.75, 0.8)
                t += 0.5
                ev['clips'].append((t, t + dur, frames_dir, p, n))
                t += dur + 0.3
                cam.to(t, vp['width'] / 2, vp['height'] * 0.37, 1.0, 0.6)
                t += 0.25
            elif k == 'wait':
                if op.get('caption'): ev['caps'].append((t, op['caption']))
                cam.to(t, vp['width'] / 2, vp['height'] * 0.4, 1.0, 0.6)
                t += op['dur']
                ev['states'].append((t, files[op['to']], 0.4, 'wipe'))
                t += 0.6
        t += 0.35
    return ev, cam, t

# ------------------------------------------------------------------ principal
def main():
    manifest = json.load(open(os.path.join(a.rec, 'manifest.json')))
    vp, scale = manifest['viewport'], manifest['scale']
    SW, SH = vp['width'] * scale, vp['height'] * scale
    # images de l'extrait : une par 1/30 s
    tmp = tempfile.mkdtemp(prefix='tuto-')
    for sc in manifest['scenes']:
        for op in sc['ops']:
            if op['op'] == 'clip':
                d = os.path.join(tmp, os.path.basename(op['file']).replace('.', '_'))
                os.makedirs(d, exist_ok=True)
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', os.path.join(a.rec, op['file']), '-vf', f'fps={FPS}', '-t', str(CLIP_MAX), '-q:v', '3', os.path.join(d, '%04d.jpg')], check=True)
                op['frames_dir'] = d
    ev, cam, main_s = build(manifest)
    total = INTRO_S + main_s + OUTRO_S
    n = int(total * FPS)
    print(f'{main_s:.1f}s de montage, {total:.1f}s au total, {n} images', file=sys.stderr)
    cache = {}
    def still(f):
        if f not in cache:
            if len(cache) > 10: cache.pop(next(iter(cache)))
            cache[f] = Image.open(os.path.join(a.rec, f)).convert('RGB')
        return cache[f]
    cursor_img, tip, cs = make_cursor()
    cursor_small = cursor_img.resize((cursor_img.width // cs, cursor_img.height // cs), Image.LANCZOS)
    cursor_press = cursor_img.resize((int(cursor_img.width / cs * 0.84), int(cursor_img.height / cs * 0.84)), Image.LANCZOS)
    tip_xy = (tip[0] / cs, tip[1] / cs)
    logo = Image.open(os.path.join(ROOT, 'public/brand/projet-lisnard-clair.png')).convert('RGBA')
    bg, mask, cfg = backdrop(), card_mask(), json.load(open(a.config))
    cap_cache, frame_cache, mask_cache = {}, {}, {}
    state_times = [e[0] for e in ev['states']]

    def cap_img(c):
        k = (c['num'], c['title'], c['hint'])
        if k not in cap_cache: cap_cache[k] = caption_layer(c['num'], c['title'], c['hint'], a.steps)
        return cap_cache[k]
    def cursor_pos(t):
        pos = None
        for t0, dur, p0, p1 in ev['moves']:
            if t0 <= t:
                e = ease(1.0 if dur <= 0 else (t - t0) / dur)
                dx, dy = p1[0] - p0[0], p1[1] - p0[1]
                dist = math.hypot(dx, dy) or 1
                bow = min(50, dist * 0.16) * (1 if dx >= 0 else -1)
                cx, cy = p0[0] + dx / 2 - dy / dist * bow, p0[1] + dy / 2 + dx / dist * bow
                pos = ((1 - e) ** 2 * p0[0] + 2 * (1 - e) * e * cx + e * e * p1[0], (1 - e) ** 2 * p0[1] + 2 * (1 - e) * e * cy + e * e * p1[1])
        return pos or (vp['width'] * 0.72, vp['height'] * 0.93)
    def rounded(w, h, r):
        k = (w, h, r)
        if k not in mask_cache:
            S = 3
            m = Image.new('L', (w * S, h * S), 0)
            ImageDraw.Draw(m).rounded_rectangle([0, 0, w * S - 1, h * S - 1], radius=r * S, fill=255)
            mask_cache[k] = m.resize((w, h), Image.LANCZOS)
        return mask_cache[k]

    def ui(t):
        cx, cy, z = cam.at(t)
        k = 1.0
        for ct in ev['cuts']:
            if ct <= t < ct + 0.5: k = 1 + 0.05 * (1 - ease((t - ct) / 0.5))
        z *= k
        cw = SW / z
        ch = cw * CARD[3] / CARD[2]
        x0 = clamp(cx * scale - cw / 2, 0, SW - cw)
        y0 = clamp(cy * scale - ch / 2, 0, SH - ch)
        f = CARD[2] / cw  # pixels du montage par pixel de l'image fixe
        def crop(img): return img.resize((CARD[2], CARD[3]), Image.LANCZOS, box=(x0, y0, x0 + cw, y0 + ch))
        i = max(0, bisect.bisect_right(state_times, t) - 1)
        _, cur_file, fade, kind = ev['states'][i]
        img = crop(still(cur_file))
        if fade > 0 and i > 0 and t - state_times[i] < fade:
            u = ease((t - state_times[i]) / fade)
            prev = crop(still(ev['states'][i - 1][1]))
            if kind == 'wipe':
                # volet qui découvre la nouvelle image du bas vers le haut (pas de superposition de deux pages différentes)
                soft = 90
                edge = (1 - u) * (CARD[3] + soft) - soft
                m = np.clip((np.arange(CARD[3], dtype=np.float32)[:, None] - edge) / soft, 0, 1)
                m = Image.fromarray((np.repeat(m, CARD[2], axis=1) * 255).astype(np.uint8))
                img = Image.composite(img, prev, m)
            else:
                img = Image.blend(prev, img, u)
        out = img.convert('RGBA')
        def to_card(px, py): return ((px * scale - x0) * f, (py * scale - y0) * f)
        # l'extrait joue dans l'écran du téléphone
        for t0, t1, d, p, nfr in ev['clips']:
            if t0 <= t <= t1 + 0.05:
                idx = min(nfr, int((t - t0) * FPS) + 1)
                if (d, idx) not in frame_cache:
                    if len(frame_cache) > 40: frame_cache.pop(next(iter(frame_cache)))
                    frame_cache[(d, idx)] = Image.open(os.path.join(d, f'{idx:04d}.jpg')).convert('RGB')
                ins = 3
                ax, ay = to_card(p['x'] + ins, p['y'] + ins)
                bx, by = to_card(p['x'] + p['w'] - ins, p['y'] + p['h'] - ins)
                w_, h_ = int(round(bx - ax)), int(round(by - ay))
                if w_ > 4 and h_ > 4:
                    fr = frame_cache[(d, idx)].resize((w_, h_), Image.LANCZOS)
                    al = ease_out((t - t0) / 0.18)
                    m = rounded(w_, h_, max(2, int(13 * scale * f)))
                    if al < 1: m = m.point(lambda v: int(v * al))
                    out.paste(fr, (int(round(ax)), int(round(ay))), m)
        ov = Image.new('RGBA', out.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        # anneau autour du bouton à toucher
        for t0, t1, r in ev['rings']:
            if t0 <= t <= t1:
                u = (t - t0)
                al = ease_out(u / 0.25) * (1 - ease((t - (t1 - 0.2)) / 0.2)) if t > t1 - 0.2 else ease_out(u / 0.25)
                pulse = 0.65 + 0.35 * math.sin(u * 7.5)
                ax, ay = to_card(r['x'] - 5, r['y'] - 5)
                bx, by = to_card(r['x'] + r['w'] + 5, r['y'] + r['h'] + 5)
                rad = int(14 * scale * f)
                for grow, wd, aa in ((0, 5, 235), (8, 9, 70)):
                    od.rounded_rectangle([ax - grow, ay - grow, bx + grow, by + grow], radius=rad + grow, outline=PINK + (int(aa * al * pulse),), width=wd)
        pressing = False
        for tc, x, y in ev['clicks']:
            age = t - tc
            if 0 <= age < 0.7:
                ox, oy = to_card(x, y)
                u = ease_out(age / 0.7)
                r = 14 + 64 * u
                aa = int(230 * (1 - u))
                od.ellipse([ox - r, oy - r, ox + r, oy + r], outline=PINK + (aa,), width=5, fill=PINK + (int(aa * 0.2),))
            if 0 <= age < 0.14: pressing = True
        out.alpha_composite(ov)
        px, py = cursor_pos(t)
        ox, oy = to_card(px, py)
        ci = cursor_press if pressing else cursor_small
        sx = ci.width / cursor_small.width
        pos = (int(ox - tip_xy[0] * sx), int(oy - tip_xy[1] * sx))
        out.paste(ci, pos, ci)
        return out

    def main_frame(t):
        canvas = bg.copy()
        u = ease_out(t / 0.4)  # la carte entre en douceur au début
        card = ui(t)
        canvas.paste(card.convert('RGB'), (CARD[0], CARD[1] + int(24 * (1 - u))), mask)
        cur = None
        for ct, c in ev['caps']:
            if ct <= t: cur = (ct, c)
        if cur:
            age = t - cur[0]
            e = ease_out(age / 0.35)
            lay = cap_img(cur[1]).copy()
            lay.putalpha(lay.getchannel('A').point(lambda v: int(v * e)))
            canvas.paste(lay, (0, PANEL_Y + int(26 * (1 - e))), lay)
        return canvas

    music = os.path.join(ROOT, 'public', 'music', cfg['music'])
    audio = build_audio(total, [c[0] for c in ev['clicks']], ev['starts'], music, a.out + '.wav')
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', audio,
           '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-af', 'loudnorm=I=-17:TP=-1.5:LRA=9', '-ar', '44100',
           '-c:a', 'aac', '-b:a', '128k', '-shortest', a.out]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    poster_at = int(1.7 * FPS)
    for i in range(n):
        t = i / FPS
        if t < INTRO_S:
            fr = intro_frame(t, cfg, logo)
            if t > INTRO_S - 0.3: fr = Image.blend(fr, main_frame(0.0), ease((t - (INTRO_S - 0.3)) / 0.3))
        elif t < INTRO_S + main_s:
            fr = main_frame(t - INTRO_S)
            if t > INTRO_S + main_s - 0.3: fr = Image.blend(fr, outro_frame(0.0, cfg, logo), ease((t - (INTRO_S + main_s - 0.3)) / 0.3))
        else:
            fr = outro_frame(t - INTRO_S - main_s, cfg, logo)
        if i == poster_at and a.poster: fr.save(a.poster, quality=88)
        ff.stdin.write(fr.tobytes())
        if i % 150 == 0: print(f'  {i}/{n}', file=sys.stderr)
    ff.stdin.close()
    ff.wait()
    os.remove(audio)

# ------------------------------------------------------------------ son
def build_audio(total, clicks, starts, music, wav_path):
    sr = 44100
    n = int(total * sr)
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', music, '-f', 's16le', '-ac', '2', '-ar', str(sr), '-'], capture_output=True, check=True).stdout
    m = np.frombuffer(raw, dtype=np.int16).reshape(-1, 2).astype(np.float32) / 32768
    reps = int(math.ceil(n / len(m))) + 1
    m = np.tile(m, (reps, 1))[:n]
    t = np.arange(n) / sr
    env = np.minimum(1, t / 0.6) * np.minimum(1, (total - t) / 1.8)
    mix = m * (env * 0.42)[:, None]
    def add(sig, at):
        i = int(at * sr)
        if 0 <= i < n:
            seg = sig[: n - i]
            mix[i:i + len(seg)] += seg[:, None]
    rng = np.random.default_rng(7)
    k = np.arange(int(0.09 * sr)) / sr
    tick = (np.sin(2 * np.pi * 1100 * k) * np.exp(-k * 55) * 0.5 + np.sin(2 * np.pi * 1650 * k) * np.exp(-k * 80) * 0.25 + rng.normal(0, 0.05, len(k)) * np.exp(-k * 120)).astype(np.float32)
    for c in clicks:
        add(tick * 0.55, INTRO_S + c)
    kk = np.arange(int(0.42 * sr)) / sr
    noise = rng.normal(0, 1, len(kk)).astype(np.float32)
    w = np.cumsum(noise)
    lp = noise * 0.0
    a_ = np.linspace(0.02, 0.5, len(kk))
    y = 0.0
    out = np.empty_like(noise)
    for i_ in range(len(noise)):
        y += a_[i_] * (noise[i_] - y)
        out[i_] = y
    swoosh = (out * np.sin(np.pi * kk / kk[-1]) ** 1.5 * 0.9).astype(np.float32)
    for ct in starts:
        add(swoosh * 0.35, INTRO_S + ct - 0.1)
    # introduction et conclusion : même musique, plus douce (déjà dans `env`) ; léger « boum » à l'arrivée du titre
    mix = np.clip(mix, -0.98, 0.98)
    pcm = (mix * 32767).astype(np.int16)
    with wave.open(wav_path, 'wb') as wf:
        wf.setnchannels(2); wf.setsampwidth(2); wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return wav_path

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('rec'); p.add_argument('out')
    p.add_argument('--config', required=True)
    p.add_argument('--steps', type=int, default=7)
    p.add_argument('--poster')
    p.add_argument('--fonts', default=os.path.join(ROOT, 'public/fonts/studio'))
    a = p.parse_args()
    main()
