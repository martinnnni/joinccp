"""材料质检编排：规则引擎（不消耗 AI）+ AI 易错点提示（失败降级）。"""
from docx import Document

from . import ai_client, rules_engine


def check_docx(path, material_name=""):
    """对上传的 .docx 做质检，返回结果列表。

    每条结果：{"kind": "rule"|"ai", "code", "message", "severity", "suggestion"}
    其中 AI 结果统一在 message 中体现"仅供参考"语义，供前端区分展示。
    """
    results = []

    # 1. 规则检查（纯规则，不消耗 AI）
    for item in rules_engine.check_docx(path):
        results.append({"kind": "rule", **item})

    # 2. AI 易错点提示（prompt 明确"只列问题、不改原文"）
    try:
        text = "\n".join(p.text for p in Document(path).paragraphs)[:4000]
        prompt = (
            f"你是党务材料审阅助手。请只列出以下《{material_name or '材料'}》中可能存在的"
            "逻辑矛盾、表述不规范、内容缺失等易错点，只列问题、不改写原文。"
            "如未发现明显问题，回复“未发现明显问题”。材料正文如下：\n\n" + text
        )
        ai_text = ai_client.chat(
            [
                {"role": "system", "content": "你是严谨的党务材料审阅助手。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=800,
        )
        results.append({
            "kind": "ai",
            "code": "ai-suggestion",
            "message": ai_text.strip(),
            "severity": "提示",
            "suggestion": "AI 建议仅供参考。",
        })
    except ai_client.AiUnavailableError:
        results.append({
            "kind": "ai",
            "code": "ai-unavailable",
            "message": "AI 服务暂不可用，已跳过 AI 易错点检查。",
            "severity": "提示",
            "suggestion": "可稍后重试，或仅依据规则检查结果。",
        })

    return results
