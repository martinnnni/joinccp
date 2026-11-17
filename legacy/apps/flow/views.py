"""材料与节点管家视图：通知。"""
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render

from .models import Notification


@login_required
def notifications(request):
    profile = getattr(request.user, "profile", None)
    items = Notification.objects.filter(student=profile) if profile else Notification.objects.none()
    return render(request, "flow/notifications.html", {"notifications": items})


@login_required
def notification_read(request, pk):
    profile = getattr(request.user, "profile", None)
    item = get_object_or_404(Notification, pk=pk, student=profile)
    item.is_read = True
    item.save()
    return redirect("notifications")
