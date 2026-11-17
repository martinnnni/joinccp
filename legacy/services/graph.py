"""Neo4j 图服务：描述《发展党员流程图》的结构关系。

图结构：
  (Stage)-[:CONTAINS]->(FlowNode)-[:REQUIRES]->(MaterialTemplate)
  (FlowNode)-[:NEXT]->(FlowNode)  表示同一阶段内流程顺序。

Neo4j 不可用（未配置 / 服务未启动 / 查询失败）时统一抛出 GraphUnavailableError，
调用方据此降级为 MySQL 关系查询，不影响网站可用性。
"""
from django.conf import settings


class GraphUnavailableError(Exception):
    """Neo4j 不可用。"""


def _driver():
    """创建 Neo4j 驱动；未配置或初始化失败时抛 GraphUnavailableError。"""
    if not settings.NEO4J.get("URI"):
        raise GraphUnavailableError("未配置 Neo4j（NEO4J_URI 为空）")
    try:
        from neo4j import GraphDatabase

        return GraphDatabase.driver(
            settings.NEO4J["URI"],
            auth=(settings.NEO4J["USER"], settings.NEO4J["PASSWORD"]),
        )
    except Exception as exc:  # noqa: BLE001
        raise GraphUnavailableError(f"Neo4j 驱动初始化失败：{exc}") from exc


def _run(query, params=None):
    """执行一条 Cypher，返回 dict 列表；任何连接/查询异常都包装为 GraphUnavailableError。"""
    driver = _driver()
    try:
        with driver.session() as session:
            result = session.run(query, params or {})
            return [dict(record) for record in result]
    except GraphUnavailableError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise GraphUnavailableError(f"Neo4j 查询失败：{exc}") from exc
    finally:
        driver.close()


def seed_graph(stages, nodes, materials):
    """把阶段 / 节点 / 材料写入 Neo4j（节点 + 关系）。"""
    _run("MATCH (n) DETACH DELETE n")
    for s in stages:
        _run(
            "MERGE (n:Stage {slug:$slug}) SET n.name=$name, n.order=$order",
            {"slug": s["slug"], "name": s["name"], "order": s["order"]},
        )
    for n in nodes:
        _run(
            "MERGE (n:FlowNode {slug:$slug}) SET n.name=$name, n.order=$order, "
            "n.stage=$stage, n.duration_rule=$rule "
            "WITH n MATCH (s:Stage {slug:$stage}) MERGE (s)-[:CONTAINS]->(n)",
            {
                "slug": n["slug"],
                "name": n["name"],
                "order": n["order"],
                "stage": n["stage"],
                "rule": n.get("duration_rule", ""),
            },
        )
    for m in materials:
        _run(
            "MERGE (n:MaterialTemplate {slug:$slug}) SET n.name=$name, "
            "n.category=$cat, n.fill_method=$fill "
            "WITH n MATCH (f:FlowNode {slug:$node}) MERGE (f)-[:REQUIRES]->(n)",
            {
                "slug": m["slug"],
                "name": m["name"],
                "cat": m["category"],
                "fill": m["fill_method"],
                "node": m["node"],
            },
        )
    _run(
        "MATCH (a:FlowNode), (b:FlowNode) WHERE a.stage=b.stage AND b.order=a.order+1 "
        "MERGE (a)-[:NEXT]->(b)"
    )


def required_materials(node_slug):
    """查询某节点所需的材料（图查询）。"""
    return _run(
        "MATCH (f:FlowNode {slug:$slug})-[:REQUIRES]->(m:MaterialTemplate) "
        "RETURN m.slug AS slug, m.name AS name ORDER BY m.name",
        {"slug": node_slug},
    )


def next_node_slug(node_slug):
    """查询某节点的下一个节点 slug（图遍历）。"""
    rows = _run(
        "MATCH (n:FlowNode {slug:$slug})-[:NEXT]->(m) RETURN m.slug AS slug",
        {"slug": node_slug},
    )
    return rows[0]["slug"] if rows else None
