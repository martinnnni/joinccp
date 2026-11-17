"""个性化成长导师视图。"""
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_POST

from services import ai_client

from .models import ChatMessage, ChatSession


def _system_prompt(profile):
    """构造系统提示词：注入学生阶段、专业等上下文。"""
    return (
        "你是学生党员发展成长导师。请结合学生当前阶段，耐心、规范地回答入党流程与党务材料问题。"
        f"学生当前阶段标识：{profile.current_stage_slug or '未知'}；专业：{profile.major or '未知'}。"
        "回答要准确、有鼓励性，不捏造组织规定；涉及时限与材料按《中国共产党发展党员工作细则》作答。"
    )


@login_required
def mentor(request):
    profile = getattr(request.user, "profile", None)
    sessions = ChatSession.objects.filter(student=profile) if profile else []
    return render(request, "mentor/chat.html", {"sessions": sessions})


@login_required
@require_POST
def chat_api(request):
    """聊天接口：返回 AI 回复，失败时降级提示。"""
    profile = getattr(request.user, "profile", None)
    if profile is None:
        return JsonResponse({"ok": False, "error": "未绑定学生档案。"}, status=400)

    content = request.POST.get("content", "").strip()
    session_id = request.POST.get("session_id")
    if not content:
        return JsonResponse({"ok": False, "error": "消息不能为空。"}, status=400)

    session = None
    if session_id:
        session = ChatSession.objects.filter(pk=session_id, student=profile).first()
    if session is None:
        session = ChatSession.objects.create(student=profile, title=content[:20] or "新对话")

    ChatMessage.objects.create(session=session, role="user", content=content)

    # 取最近若干条历史构造上下文
    history = list(session.messages.order_by("-created_at")[:10])
    history.reverse()
    messages = [{"role": "system", "content": _system_prompt(profile)}]
    for m in history:
        messages.append({"role": "assistant" if m.role == "assistant" else "user", "content": m.content})

    try:
        reply = ai_client.chat(messages, temperature=0.4, max_tokens=1000)
    except ai_client.AiUnavailableError as exc:
        reply = f"（AI 服务暂不可用，请稍后重试：{exc}）"

    ChatMessage.objects.create(session=session, role="assistant", content=reply)
    return JsonResponse({"ok": True, "session_id": session.pk, "reply": reply})
