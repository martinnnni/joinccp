"""初始化《发展党员流程图》数据并同步到 Neo4j。

用法：python manage.py seed_flow
"""
from django.core.management.base import BaseCommand

from apps.flow import flow_data
from apps.flow.models import FlowNode, MaterialTemplate, Stage
from services import graph


class Command(BaseCommand):
    help = "按《发展党员流程图》初始化阶段/节点/材料模板，并同步到 Neo4j"

    def handle(self, *args, **options):
        # 1. 写入 MySQL（阶段 / 节点 / 材料）
        for s in flow_data.STAGES:
            Stage.objects.update_or_create(
                slug=s["slug"], defaults={"name": s["name"], "order": s["order"]}
            )
        for n in flow_data.NODES:
            stage = Stage.objects.get(slug=n["stage"])
            FlowNode.objects.update_or_create(
                slug=n["slug"],
                defaults={
                    "stage": stage,
                    "order": n["order"],
                    "name": n["name"],
                    "duration_rule": n.get("duration_rule", ""),
                    "duration_days": n.get("duration_days", 0),
                    "remind_days_before": n.get("remind_days_before", 0),
                },
            )
        for m in flow_data.MATERIALS:
            stage = Stage.objects.get(slug=m["stage"])
            node = FlowNode.objects.filter(slug=m["node"]).first()
            MaterialTemplate.objects.update_or_create(
                slug=m["slug"],
                defaults={
                    "name": m["name"],
                    "stage": stage,
                    "node": node,
                    "category": m["category"],
                    "fill_method": m["fill_method"],
                },
            )
        self.stdout.write(
            self.style.SUCCESS(
                f"MySQL 已初始化：{len(flow_data.STAGES)} 阶段 / "
                f"{len(flow_data.NODES)} 节点 / {len(flow_data.MATERIALS)} 材料"
            )
        )

        # 2. 同步 Neo4j 图结构（不可用时降级提示，不阻断）
        try:
            graph.seed_graph(flow_data.STAGES, flow_data.NODES, flow_data.MATERIALS)
            self.stdout.write(self.style.SUCCESS("Neo4j 图结构已同步"))
        except graph.GraphUnavailableError as exc:
            self.stdout.write(self.style.WARNING(f"Neo4j 同步跳过：{exc}"))
