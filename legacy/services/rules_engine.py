"""材料格式规则引擎（纯规则，不消耗 AI）。

用 python-docx 解析 .docx 段落格式，检查字体、字号、标题居中、落款日期等。
返回结构化规则结果列表：
[{"code", "message", "severity", "suggestion"}, ...]
"""
import re

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH

# 期望字体/字号（党务材料常见规范：正文仿宋_GB2312 三号=16pt，标题黑体/小标宋 二号=22pt）
BODY_FONTS = ("仿宋", "仿宋_GB2312", "FangSong", "FangSong_GB2312")
TITLE_FONTS = ("黑体", "SimHei", "小标宋")
BODY_SIZE_PT = 16.0
TITLE_SIZE_PT = 22.0

_EAST_ASIA_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _run_font_name(run):
    """优先取东亚字体名，回退到 run.font.name。"""
    name = run.font.name or ""
    try:
        r_pr = run._element.rPr
        if r_pr is not None and r_pr.rFonts is not None:
            east = r_pr.rFonts.get(_EAST_ASIA_NS + "eastAsia")
            if east:
                return east
    except Exception:
        pass
    return name


def check_docx(path):
    """对 .docx 做规则检查，返回规则结果列表。"""
    results = []
    doc = Document(path)
    paragraphs = [p for p in doc.paragraphs if p.text.strip()]

    if not paragraphs:
        return [{
            "code": "empty",
            "message": "文档为空或无法解析出段落。",
            "severity": "高",
            "suggestion": "请上传内容完整的材料。",
        }]

    # 1. 标题居中检查
    if paragraphs[0].alignment != WD_ALIGN_PARAGRAPH.CENTER:
        results.append({
            "code": "title-not-centered",
            "message": "标题未居中。",
            "severity": "中",
            "suggestion": "将标题段落设置为居中对齐。",
        })

    # 2. 正文字体/字号检查（跳过标题段）
    font_problems = []
    size_problems = []
    for para in paragraphs[1:]:
        for run in para.runs:
            font = _run_font_name(run)
            size = run.font.size.pt if run.font.size else None
            if font and font not in BODY_FONTS:
                font_problems.append(font)
            if size is not None and abs(size - BODY_SIZE_PT) > 0.5:
                size_problems.append(f"{size}pt")
    if font_problems:
        results.append({
            "code": "font-mismatch",
            "message": f"正文存在字体不规范：{', '.join(sorted(set(font_problems)))}。",
            "severity": "中",
            "suggestion": "正文应使用仿宋_GB2312。",
        })
    if size_problems:
        results.append({
            "code": "size-mismatch",
            "message": f"正文存在字号不规范：{', '.join(sorted(set(size_problems)))}。",
            "severity": "中",
            "suggestion": "正文应使用三号（16pt）。",
        })

    # 3. 落款检查（末尾两段应含署名与日期）
    tail = "".join(p.text for p in paragraphs[-2:])
    has_date = bool(re.search(r"\d{4}\s*[年./-]\s*\d{1,2}", tail))
    has_sign = bool(re.search(r"(申请人|汇报人|签名|署名|：)", tail))
    if not (has_date and has_sign):
        results.append({
            "code": "missing-signature",
            "message": "文末缺少落款（署名与日期）。",
            "severity": "中",
            "suggestion": "在正文右下方补充署名与日期，如：申请人：{{姓名}}　{{日期}}。",
        })

    return results
