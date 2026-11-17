"""配置包：用 pymysql 作为 MySQL 驱动（纯 Python，跨平台免编译），并暴露 Celery 应用。"""
import pymysql

pymysql.install_as_MySQLdb()

from .celery import app as celery_app

__all__ = ("celery_app",)
