"""智能材料质检视图。"""
import os
import tempfile

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_POST

from apps.flow.models import MaterialTemplate
from services import quality_check

from .models import CheckResult, MaterialCheckRecord


@login_required
def check(request):
    profile = getattr(request.user, "profile", None)
    materials = MaterialTemplate.objects.all()
    return render(request, "quality/check.html", {"materials": materials, "profile": profile})


@login_required
@require_POST
def check_api(request):
    """上传 .docx 并返回质检结果（规则检查 + AI 建议）。"""
    profile = getattr(request.user, "profile", None)
    if profile is None:
        return JsonResponse({"ok": False, "error": "未绑定学生档案。"}, status=400)

    docx = request.FILES.get("docx")
    material_id = request.POST.get("material_id")
    if not docx or not material_id:
        return JsonResponse({"ok": False, "error": "缺少文件或材料。"}, status=400)
    if not docx.name.lower().endswith(".docx"):
        return JsonResponse({"ok": False, "error": "仅支持 .docx 文件。"}, status=400)

    material = get_object_or_404(MaterialTemplate, pk=material_id)

    # 先落到临时文件供 python-docx 解析（上传文件对象可直接读，这里复用临时文件便于规则引擎）
    suffix = os.path.splitext(docx.name)[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        for chunk in docx.chunks():
            tmp.write(chunk)
        tmp_path = tmp.name
    try:
        results = quality_check.check_docx(tmp_path, material.name)
    finally:
        os.unlink(tmp_path)

    # 持久化质检记录与结果
    record = MaterialCheckRecord.objects.create(student=profile, material=material, docx=docx)
    for r in results:
        CheckResult.objects.create(record=record, **r)

    return JsonResponse({"ok": True, "results": results})
