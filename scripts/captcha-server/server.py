import logging
import sys
from itertools import permutations
from typing import Dict, List, Optional, Tuple

SHORT_PACKAGES = r"C:\ocr-py\Lib\site-packages"
if SHORT_PACKAGES not in sys.path:
    sys.path.insert(0, SHORT_PACKAGES)

import cv2
import ddddocr
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("captcha-server")

app = FastAPI(title="Captcha OCR Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ddddocr_det = ddddocr.DdddOcr(det=True, ocr=False, show_ad=False)
ddddocr_ocr = ddddocr.DdddOcr(ocr=True, det=False, show_ad=False, beta=True)


def _detect_boxes(img: np.ndarray, image_bytes: bytes) -> List[Tuple[int, int, int, int]]:
    h, w = img.shape[:2]

    try:
        bboxes = ddddocr_det.detection(image_bytes)
        bboxes = _filter_boxes(bboxes, w, h)
    except Exception:
        bboxes = []

    logger.info("ddddocr detected %d boxes", len(bboxes))

    if len(bboxes) < 3:
        extra = _detect_by_contour(img)
        existing = set()
        for b in bboxes:
            cx, cy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
            existing.add((cx, cy))
        for b in extra:
            cx, cy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
            if any(abs(cx - ex) < 20 and abs(cy - ey) < 20 for (ex, ey) in existing):
                continue
            bboxes.append(b)
            existing.add((cx, cy))

        if extra:
            logger.info("contour fallback added %d extra boxes", len(extra))

    return bboxes


def _filter_boxes(
    boxes: List[Tuple[int, int, int, int]], img_w: int, img_h: int,
    min_size: int = 20, max_size_ratio: float = 0.3,
) -> List[Tuple[int, int, int, int]]:
    filtered = []
    for x1, y1, x2, y2 in boxes:
        bw = x2 - x1
        bh = y2 - y1
        if bw < min_size or bh < min_size:
            continue
        if bw > img_w * max_size_ratio or bh > img_h * max_size_ratio:
            continue
        if x1 < 0 or y1 < 0 or x2 > img_w or y2 > img_h:
            continue
        filtered.append((x1, y1, x2, y2))
    return filtered


def _detect_by_contour(img: np.ndarray) -> List[Tuple[int, int, int, int]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    thresh = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 15, 4)
    kernel = np.ones((2, 2), np.uint8)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    h, w = img.shape[:2]
    area_min = (w * h) * 0.005
    area_max = (w * h) * 0.12
    boxes = []
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        area = bw * bh
        if area < area_min or area > area_max:
            continue
        ratio = max(bw, bh) / max(min(bw, bh), 1)
        if ratio > 2.0:
            continue
        boxes.append((x, y, x + bw, y + bh))

    boxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    return boxes[:5]


def _preprocess_crop(crop: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


PADS = (3, 0, 6)


def _classify_single_crop(
    crop: np.ndarray, target_chars: List[str],
) -> Dict[str, float]:
    char_probs: Dict[str, float] = {ch: 0.0 for ch in target_chars}

    for crop_variant in (crop, _preprocess_crop(crop)):
        _, crop_bytes = cv2.imencode(".png", crop_variant)
        crop_bytes = crop_bytes.tobytes()

        try:
            result = ddddocr_ocr.classification(crop_bytes, probability=True)
        except Exception:
            continue

        r_charset = result.get("charset", [])
        probs_raw = result.get("probabilities", [])

        if not r_charset or not probs_raw:
            continue

        probs = np.array(probs_raw)
        if probs.ndim == 3:
            timestep_probs = probs[:, 0, :]
        elif probs.ndim == 2:
            timestep_probs = probs
        else:
            continue

        for ch in target_chars:
            if ch in r_charset:
                idx = r_charset.index(ch)
                prob = float(np.max(timestep_probs[:, idx]))
                if prob > char_probs[ch]:
                    char_probs[ch] = prob

    return char_probs


def _classify_boxes_prob(
    img: np.ndarray, bboxes: List[Tuple[int, int, int, int]],
    target_chars: List[str],
) -> List[Tuple[Dict[str, float], float, float]]:
    h, w = img.shape[:2]
    results: List[Tuple[Dict[str, float], float, float]] = []

    for box in bboxes:
        x1, y1, x2, y2 = box
        best_probs: Dict[str, float] = {ch: 0.0 for ch in target_chars}

        for pad in PADS:
            cx1 = max(0, x1 - pad)
            cy1 = max(0, y1 - pad)
            cx2 = min(w, x2 + pad)
            cy2 = min(h, y2 + pad)
            crop = img[cy1:cy2, cx1:cx2]

            if crop.size == 0:
                continue

            char_probs = _classify_single_crop(crop, target_chars)
            score = sum(char_probs.values())

            if score > sum(best_probs.values()):
                best_probs = char_probs

            if score >= 0.1:
                break

        cx = float((x1 + x2) / 2)
        cy = float((y1 + y2) / 2)
        results.append((best_probs, cx, cy))

        if best_probs:
            top_char = max(best_probs, key=best_probs.get)
            top_prob = best_probs[top_char]
            probs_str = {k: round(v, 3) for k, v in
                         sorted(best_probs.items(), key=lambda x: -x[1])}
            logger.info("  box (%.0f, %.0f): top='%s' (%.3f) probs=%s",
                        cx, cy, top_char, top_prob, probs_str)

    return results


def _solve_assignment(
    boxes: List[Tuple[Dict[str, float], float, float]],
    target_chars: List[str],
    conf_threshold: float,
) -> Optional[Dict[str, Tuple[float, float]]]:
    n_boxes = len(boxes)
    n_chars = len(target_chars)

    if n_boxes < n_chars:
        return None

    valid_assignments: List[Tuple[tuple, float, float]] = []
    best_fallback: Optional[Tuple[tuple, float, list]] = None
    best_fallback_total = -1.0

    for perm in permutations(range(n_boxes), n_chars):
        probs = [boxes[perm[i]][0].get(target_chars[i], 0.0) for i in range(n_chars)]
        total = sum(probs)
        min_prob = min(probs)

        if total > best_fallback_total:
            best_fallback_total = total
            best_fallback = (perm, total, probs)

        if min_prob >= conf_threshold:
            valid_assignments.append((perm, total, min_prob))

    if valid_assignments:
        best = max(valid_assignments, key=lambda x: x[1])
        perm = best[0]
        logger.info("assignment: confident (all >= %.3f)", conf_threshold)
    else:
        perm, _, probs = best_fallback
        acceptable = sum(1 for p in probs if p >= 0.01)
        if acceptable >= n_chars - 1:
            logger.info("assignment: fallback (acceptable=%d/%d, probs=%s)",
                        acceptable, n_chars,
                        [round(p, 3) for p in probs])
        else:
            logger.info("no valid assignment (acceptable=%d/%d, need %d, probs=%s)",
                        acceptable, n_chars, n_chars - 1,
                        [round(p, 3) for p in probs])
            return None

    result: Dict[str, Tuple[float, float]] = {}
    for i, ch in enumerate(target_chars):
        box_idx = perm[i]
        _, cx, cy = boxes[box_idx]
        result[ch] = (cx, cy)

    return result


class SolveRequest(BaseModel):
    image_url: str
    chars: List[str]
    confidence_threshold: Optional[float] = 0.1
    det_thresh: Optional[float] = None
    det_box_thresh: Optional[float] = None
    det_unclip_ratio: Optional[float] = None
    rec_score_thresh: Optional[float] = None


@app.get("/ping")
async def ping():
    return {"ok": True}


class CharPosition(BaseModel):
    char: str
    x: float
    y: float


class SolveResponse(BaseModel):
    positions: List[CharPosition]
    image_width: int
    image_height: int


@app.post("/solve", response_model=SolveResponse)
async def solve(req: SolveRequest):
    logger.info("solve request: chars=%s", req.chars)
    conf_threshold = req.confidence_threshold if req.confidence_threshold is not None else 0.1

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(req.image_url)
            resp.raise_for_status()
            image_bytes = resp.content
    except Exception as e:
        logger.error("download image failed: %s", e)
        raise HTTPException(status_code=502, detail=f"download image failed: {e}")

    try:
        img = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(img, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error("decode image failed: %s", e)
        raise HTTPException(status_code=502, detail=f"decode image failed: {e}")

    if img is None:
        raise HTTPException(status_code=502, detail="decoded image is None")

    h, w = img.shape[:2]
    logger.info("image size: %dx%d", w, h)

    target_chars = req.chars
    bboxes = _detect_boxes(img, image_bytes)
    logger.info("detected %d boxes overall", len(bboxes))

    if not bboxes:
        raise HTTPException(status_code=404, detail="no characters detected")

    box_results = _classify_boxes_prob(img, bboxes, target_chars)

    if not box_results:
        raise HTTPException(status_code=404, detail="classification failed for all boxes")

    detected = _solve_assignment(box_results, target_chars, conf_threshold)

    if detected is None:
        raise HTTPException(status_code=404, detail="no valid char assignment found")

    logger.info("matched: %s",
                {k: (round(v[0], 1), round(v[1], 1)) for k, v in detected.items()})

    positions = []
    for ch in target_chars:
        if ch not in detected:
            logger.warning("char '%s' not found", ch)
            raise HTTPException(status_code=404, detail=f"char '{ch}' not found in image")
        cx, cy = detected[ch]
        positions.append(CharPosition(char=ch, x=cx, y=cy))

    return SolveResponse(positions=positions, image_width=w, image_height=h)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9876, log_level="info")
