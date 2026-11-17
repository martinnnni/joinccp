"""账号与档案视图。"""
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.shortcuts import redirect, render
from django.utils import timezone

from apps.flow.models import FlowNode, MaterialTemplate, Stage

from .forms import StudentRegistrationForm
from .models import StudentProfile


def home(request):
    """根路径：已登录跳档案页，未登录跳登录页。"""
    if request.user.is_authenticated:
        return redirect("profile")
    return redirect("login")


def register(request):
    """学生注册：创建账号并自动创建个人进度档案。"""
    if request.method == "POST":
        form = StudentRegistrationForm(request.POST)
        if form.is_valid():
            with transaction.atomic():
                user = form.save()
                StudentProfile.objects.create(
                    user=user,
                    name=form.cleaned_data["name"],
                    student_no=form.cleaned_data["student_no"],
                    department=form.cleaned_data["department"],
                    major=form.cleaned_data.get("major", ""),
                    grade=form.cleaned_data.get("grade", ""),
                    phone=form.cleaned_data.get("phone", ""),
                    applied_at=form.cleaned_data.get("applied_at"),
                    current_stage_slug="application",
                    current_node_slug="apply",
                    node_entered_at=timezone.localdate(),
                )
            login(request, user)
            messages.success(request, "注册成功，个人进度档案已自动创建。")
            return redirect("profile")
    else:
        form = StudentRegistrationForm()
    return render(request, "accounts/register.html", {"form": form})


@login_required
def profile(request):
    """档案页：当前阶段、材料清单（已有/缺失）、截止节点。"""
    profile = getattr(request.user, "profile", None)
    if profile is None:
        return redirect("register")

    stage = Stage.objects.filter(slug=profile.current_stage_slug).first()
    node = FlowNode.objects.filter(slug=profile.current_node_slug).first()

    # 当前阶段材料清单 + 状态（纯数据库查询，不调用 AI）
    materials = []
    if stage:
        for m in MaterialTemplate.objects.filter(stage=stage).select_related("node"):
            record = profile.material_records.filter(material=m).first()
            materials.append({
                "material": m,
                "status": record.status if record else "未交",
                "record": record,
            })

    # 下一步节点：优先 Neo4j 图遍历，降级 MySQL
    next_node = None
    if node:
        try:
            from services import graph

            nxt = graph.next_node_slug(node.slug)
            next_node = FlowNode.objects.filter(slug=nxt).first() if nxt else None
        except Exception:
            next_node = FlowNode.objects.filter(stage=node.stage, order=node.order + 1).first()

    context = {
        "profile": profile,
        "stage": stage,
        "node": node,
        "materials": materials,
        "next_node": next_node,
    }
    return render(request, "accounts/profile.html", context)
