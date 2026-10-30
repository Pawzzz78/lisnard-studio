#!/usr/bin/env python3
"""Vidéo d'exemple pour les tutoriels : une silhouette qui « parle » devant un fond bleu (aucune personne réelle), 1280 x 720, 25 images/s."""
import math, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

out, seconds = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 60
W, H, FPS = 1280, 720, 25
BG0, BG1 = np.array([12, 20, 78], np.float32), np.array([34, 46, 140], np.float32)
yy = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
xx = np.linspace(0, 1, W, dtype=np.float32)[None, :, None]
base = BG0 * (1 - yy) + BG1 * yy
vign = 1 - 0.45 * (((xx - 0.5) ** 2) * 2.2 + ((yy - 0.45) ** 2) * 1.2)
ff = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
for i in range(seconds * FPS):
    t = i / FPS
    # lumière douce qui se déplace en diagonale
    band = np.clip(1 - np.abs((xx * 1.0 + yy * 0.6) - ((t * 0.07) % 1.6 - 0.3)) * 5, 0, 1) * 18
    frame = np.clip(base * vign + band, 0, 255).astype(np.uint8)
    img = Image.fromarray(frame)
    fig = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(fig)
    bob = 5 * math.sin(2 * math.pi * t / 3.1)
    sway = 9 * math.sin(2 * math.pi * t / 5.3)
    cx = 640 + sway * 0.5
    body = (120, 138, 192, 255)
    d.rounded_rectangle([cx - 300, 470 + bob, cx + 300, 820], radius=170, fill=body)          # épaules
    d.rectangle([cx - 52, 395 + bob, cx + 52, 505 + bob], fill=(104, 121, 176, 255))           # cou
    d.ellipse([cx - 114 + sway, 192 + bob, cx + 114 + sway, 420 + bob], fill=(70, 84, 140, 255))  # cheveux
    d.ellipse([cx - 104 + sway, 224 + bob, cx + 104 + sway, 446 + bob], fill=(150, 166, 214, 255))  # visage
    fig = fig.filter(ImageFilter.GaussianBlur(1.6))
    img = Image.alpha_composite(img.convert('RGBA'), fig)
    # ondes de voix
    wd = ImageDraw.Draw(img)
    for k in range(9):
        h = 14 + 34 * abs(math.sin(t * 5.1 + k * 0.9) * math.sin(t * 2.3 + k * 1.7))
        wd.rounded_rectangle([90 + k * 22, 640 - h / 2, 90 + k * 22 + 11, 640 + h / 2], radius=5, fill=(222, 219, 189, 210))
    ff.stdin.write(img.convert('RGB').tobytes())
ff.stdin.close()
ff.wait()
