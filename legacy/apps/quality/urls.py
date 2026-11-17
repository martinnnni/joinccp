"""智能材料质检 URL 路由。"""
from django.urls import path

from . import views

urlpatterns = [
    path("check/", views.check, name="check"),
    path("check/api/", views.check_api, name="check_api"),
]
