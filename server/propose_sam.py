"""The first pass at the walkable ground. It is rough on purpose.

Segment Anything has no idea what a floor is, so this asks it for every region
it can find and then keeps the ones that behave like ground: big enough to
stand on, not sitting up in the sky, not the whole frame. The union of those
becomes level 40 (ground). The person fixes it after, which is the point.

  python propose_sam.py --image in.png --out levels.png [--checkpoint x.pth]

Writes a grayscale png in the level encoding (0 blocked, 40 ground) and prints
one json line of counts on stdout.
"""
import argparse
import json
import sys
import time

import cv2
import numpy as np
import torch
from segment_anything import SamAutomaticMaskGenerator, sam_model_registry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--model-type", default="vit_b")
    ap.add_argument("--points-per-side", type=int, default=20)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    t0 = time.time()
    bgra = cv2.imread(args.image, cv2.IMREAD_UNCHANGED)
    if bgra is None:
        raise SystemExit("could not read " + args.image)
    if bgra.ndim == 2:
        bgra = cv2.cvtColor(bgra, cv2.COLOR_GRAY2BGRA)
    if bgra.shape[2] == 3:
        bgra = cv2.cvtColor(bgra, cv2.COLOR_BGR2BGRA)
    h, w = bgra.shape[:2]
    rgb = cv2.cvtColor(bgra[:, :, :3], cv2.COLOR_BGR2RGB)
    alpha = bgra[:, :, 3]

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    sam = sam_model_registry[args.model_type](checkpoint=args.checkpoint)
    sam.to(device)
    gen = SamAutomaticMaskGenerator(
        sam,
        points_per_side=args.points_per_side,
        pred_iou_thresh=0.86,
        stability_score_thresh=0.9,
        min_mask_region_area=48,
    )
    try:
        masks = gen.generate(rgb)
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        sam.to("cpu")
        device = "cpu"
        masks = SamAutomaticMaskGenerator(
            sam,
            points_per_side=args.points_per_side,
            pred_iou_thresh=0.86,
            stability_score_thresh=0.9,
            min_mask_region_area=48,
        ).generate(rgb)

    total = float(w * h)
    ground = np.zeros((h, w), dtype=bool)
    kept = 0
    for m in sorted(masks, key=lambda m: m["area"], reverse=True):
        seg = m["segmentation"]
        frac = m["area"] / total
        if frac < 0.004 or frac > 0.55:
            continue
        ys, xs = np.nonzero(seg)
        if len(ys) == 0:
            continue
        # ground sits low in the frame and is wider than it is tall
        cy = ys.mean() / h
        spread_x = (xs.max() - xs.min() + 1) / w
        spread_y = (ys.max() - ys.min() + 1) / h
        if cy < 0.34:
            continue
        if spread_y > 0.9 and spread_x < 0.25:
            continue
        ground |= seg
        kept += 1

    # anything the painting left transparent is not ground
    if alpha.min() < 250:
        ground &= alpha > 8

    # close pinholes, drop specks
    k = np.ones((3, 3), np.uint8)
    g8 = cv2.morphologyEx(ground.astype(np.uint8), cv2.MORPH_CLOSE, k, iterations=1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(g8, 8)
    out = np.zeros((h, w), np.uint8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 60:
            out[lab == i] = 40

    cv2.imwrite(args.out, out)
    print(
        json.dumps(
            {
                "masks": len(masks),
                "kept": kept,
                "walkable": int((out > 0).sum()),
                "pct": round(100.0 * float((out > 0).sum()) / total, 1),
                "device": device,
                "seconds": round(time.time() - t0, 1),
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # one line, so the node side can show it
        print(json.dumps({"error": str(e)[:300]}), file=sys.stderr)
        raise
