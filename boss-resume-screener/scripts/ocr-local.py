# -*- coding: utf-8 -*-
"""RapidOCR 本地识别 runner（v2.10.0，BOSS 截图取文主通道；PII 纯本地不出机）。

用法（Node 侧 ocr-local.js spawn，不直接人工调用）：
  uv run --with rapidocr-onnxruntime python ocr-local.py <img1> [img2 ...]

stdout 输出 JSON（UTF-8）：
  [{ "file": "<路径>", "ok": true, "ms": 5.2, "lines": [{"text": "...", "score": 0.98}, ...] }, ...]
  单图失败不影响其他图：{"file":..., "ok": false, "error": "..."}。
行序 = RapidOCR 阅读序（上→下）；不做合并/去重/剥UI（Node 侧 assembleOcrText 负责）。
"""
import json
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main() -> int:
    files = [a for a in sys.argv[1:] if a and not a.startswith("-")]
    if not files:
        print(json.dumps({"error": "no input files"}))
        return 1
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:  # 依赖缺失：让 Node 侧走 AI 转写兜底
        print(json.dumps({"error": f"rapidocr unavailable: {e}"}))
        return 2
    engine = RapidOCR()
    out = []
    for f in files:
        t0 = time.time()
        try:
            result, _ = engine(f)
            lines = [
                {"text": str(t), "score": round(float(s), 3)}
                for _, t, s in (result or [])
                if str(t).strip()
            ]
            out.append({"file": f, "ok": True, "ms": round(time.time() - t0, 1), "lines": lines})
        except Exception as e:
            out.append({"file": f, "ok": False, "error": str(e)[:200]})
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
