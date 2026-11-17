"""ASGI 入口（本机同步部署即可，聊天用 fetch 轮询，无需 WebSocket）。"""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

application = get_asgi_application()
