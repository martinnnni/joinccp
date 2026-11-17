"""个性化成长导师 URL 路由。"""
from django.urls import path

from . import views

urlpatterns = [
    path("mentor/", views.mentor, name="mentor"),
    path("mentor/api/", views.chat_api, name="chat_api"),
]
