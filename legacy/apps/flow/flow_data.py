"""《发展党员流程图》种子数据（五阶段 / 节点 / 材料）。

数据来源：发展党员流程图(1).pdf，按《中国共产党发展党员工作细则》整理。
阶段/节点用稳定 ASCII slug 作为标识，MySQL 与 Neo4j 共用同一套 slug。
示例人物一律化名，材料撰写要点用 {{占位符}}。
"""

STAGES = [
    {"order": 1, "slug": "application", "name": "申请入党"},
    {"order": 2, "slug": "activist", "name": "积极分子的确定与培养考察"},
    {"order": 3, "slug": "development-target", "name": "发展对象的确定与考察"},
    {"order": 4, "slug": "probationary-acceptance", "name": "预备党员的接收"},
    {"order": 5, "slug": "probationary-regularization", "name": "预备党员的培养考察与转正"},
]

# 字段：stage, order, slug, name, duration_rule, duration_days, remind_days_before
NODES = [
    {"stage": "application", "order": 1, "slug": "apply", "name": "提出入党申请", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "application", "order": 2, "slug": "first-talk", "name": "首次谈话", "duration_rule": "1 个月内", "duration_days": 30, "remind_days_before": 20},

    {"stage": "activist", "order": 1, "slug": "confirm-activist", "name": "确定入党积极分子", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "activist", "order": 2, "slug": "confirm-contact", "name": "确定培养联系人", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "activist", "order": 3, "slug": "activist-training", "name": "积极分子的培养与考察", "duration_rule": "≥1 年", "duration_days": 365, "remind_days_before": 30},

    {"stage": "development-target", "order": 1, "slug": "dev-plan", "name": "确定发展计划", "duration_rule": "年初/上年底", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 2, "slug": "symposium-1", "name": "第一次座谈会", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 3, "slug": "confirm-dev-target", "name": "确定发展对象", "duration_rule": "≥1 年", "duration_days": 365, "remind_days_before": 0},
    {"stage": "development-target", "order": 4, "slug": "dev-report", "name": "发展对象的呈报", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 5, "slug": "publicity-1", "name": "第一次公示", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 6, "slug": "confirm-introducer", "name": "确定入党介绍人", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 7, "slug": "dev-review", "name": "发展对象的审查与教育", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 8, "slug": "pre-review", "name": "两级预审", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "development-target", "order": 9, "slug": "report-up", "name": "材料上报上级党委", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},

    {"stage": "probationary-acceptance", "order": 1, "slug": "fill-volunteer", "name": "填写入党志愿书", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-acceptance", "order": 2, "slug": "branch-vote-1", "name": "支部大会讨论表决", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-acceptance", "order": 3, "slug": "committee-approve", "name": "党委会审批", "duration_rule": "1 个月内", "duration_days": 30, "remind_days_before": 20},
    {"stage": "probationary-acceptance", "order": 4, "slug": "oath", "name": "入党宣誓", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},

    {"stage": "probationary-regularization", "order": 1, "slug": "probationary-training", "name": "预备党员的培养与考察", "duration_rule": "≥1 年", "duration_days": 365, "remind_days_before": 30},
    {"stage": "probationary-regularization", "order": 2, "slug": "regularization-apply", "name": "提出转正申请", "duration_rule": "期满前 1–2 周", "duration_days": 365, "remind_days_before": 14},
    {"stage": "probationary-regularization", "order": 3, "slug": "regularization-defense", "name": "转正答辩", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-regularization", "order": 4, "slug": "symposium-2", "name": "第二次座谈会", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-regularization", "order": 5, "slug": "branch-vote-2", "name": "支部大会讨论转正", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-regularization", "order": 6, "slug": "publicity-2", "name": "转正公示", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-regularization", "order": 7, "slug": "committee-approve-2", "name": "党委会审批转正", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
    {"stage": "probationary-regularization", "order": 8, "slug": "archive", "name": "材料归档", "duration_rule": "", "duration_days": 0, "remind_days_before": 0},
]

# 字段：stage, node, slug, name, category(A/B/C), fill_method(red/blue/black)
MATERIALS = [
    # 阶段一：申请入党
    {"stage": "application", "node": "apply", "slug": "application_letter", "name": "入党申请书", "category": "A", "fill_method": "red"},
    {"stage": "application", "node": "apply", "slug": "applicant_registration", "name": "入党申请人登记表", "category": "B", "fill_method": "black"},
    {"stage": "application", "node": "first-talk", "slug": "applicant_talk_record", "name": "入党申请人谈话记实表", "category": "B", "fill_method": "black"},

    # 阶段二：积极分子的确定与培养考察
    {"stage": "activist", "node": "activist-training", "slug": "activist_inspection_form", "name": "入党积极分子考察登记表", "category": "B", "fill_method": "black"},
    {"stage": "activist", "node": "confirm-contact", "slug": "contact_person_form", "name": "培养联系人登记表", "category": "B", "fill_method": "black"},
    {"stage": "activist", "node": "activist-training", "slug": "thought_report_activist", "name": "思想汇报（积极分子）", "category": "A", "fill_method": "red"},
    {"stage": "activist", "node": "confirm-activist", "slug": "member_recommendation_summary", "name": "党员推荐入党积极分子汇总表", "category": "B", "fill_method": "black"},
    {"stage": "activist", "node": "confirm-activist", "slug": "league_member_recommendation", "name": "推荐优秀团员作入党积极分子审核表", "category": "B", "fill_method": "black"},
    {"stage": "activist", "node": "activist-training", "slug": "party_class_certificate_activist", "name": "党课结业证及党课心得（积极分子）", "category": "A", "fill_method": "red"},
    {"stage": "activist", "node": "activist-training", "slug": "autobiography", "name": "自传", "category": "A", "fill_method": "red"},
    {"stage": "activist", "node": "activist-training", "slug": "transcript", "name": "成绩单（研究生需导师推荐意见表）", "category": "A", "fill_method": "black"},

    # 阶段三：发展对象的确定与考察
    {"stage": "development-target", "node": "dev-plan", "slug": "dev_plan_branch_meeting", "name": "确立发展计划支委会会议记录", "category": "C", "fill_method": "black"},
    {"stage": "development-target", "node": "dev-plan", "slug": "dev_plan_committee_meeting", "name": "确立发展计划党委会会议记录", "category": "C", "fill_method": "black"},
    {"stage": "development-target", "node": "symposium-1", "slug": "mass_opinion_symposium", "name": "确定为发展对象征求党内外群众意见会议记录", "category": "C", "fill_method": "black"},
    {"stage": "development-target", "node": "confirm-dev-target", "slug": "dev_target_branch_meeting", "name": "确立发展对象支委会会议记录", "category": "C", "fill_method": "black"},
    {"stage": "development-target", "node": "dev-review", "slug": "political_review_form", "name": "发展对象政审表", "category": "A", "fill_method": "blue"},
    {"stage": "development-target", "node": "dev-report", "slug": "dev_target_report_form", "name": "发展对象呈报表", "category": "B", "fill_method": "black"},
    {"stage": "development-target", "node": "dev-review", "slug": "external_political_review", "name": "外调政审材料", "category": "A", "fill_method": "blue"},
    {"stage": "development-target", "node": "pre-review", "slug": "pre_review_form", "name": "发展党员工作预审表（两级预审）", "category": "B", "fill_method": "blue"},
    {"stage": "development-target", "node": "dev-review", "slug": "party_class_certificate_dev", "name": "党课结业证及党课心得（发展对象）", "category": "A", "fill_method": "red"},
    {"stage": "development-target", "node": "publicity-1", "slug": "publicity_record", "name": "发展党员公示情况登记表", "category": "B", "fill_method": "black"},
    {"stage": "development-target", "node": "confirm-introducer", "slug": "introducer_form", "name": "入党介绍人登记表", "category": "B", "fill_method": "black"},
    {"stage": "development-target", "node": "dev-review", "slug": "comprehensive_review_report", "name": "综合审查报告", "category": "A", "fill_method": "blue"},
    {"stage": "development-target", "node": "report-up", "slug": "volunteer_form_intro_letter", "name": "领取入党志愿书介绍信", "category": "B", "fill_method": "blue"},

    # 阶段四：预备党员的接收
    {"stage": "probationary-acceptance", "node": "fill-volunteer", "slug": "volunteer_form_before", "name": "入党志愿书（发展前填写）", "category": "A", "fill_method": "red"},
    {"stage": "probationary-acceptance", "node": "branch-vote-1", "slug": "acceptance_vote_summary", "name": "接收预备党员表决票汇总表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-acceptance", "node": "branch-vote-1", "slug": "acceptance_branch_meeting", "name": "接收预备党员会议记录", "category": "C", "fill_method": "black"},
    {"stage": "probationary-acceptance", "node": "committee-approve", "slug": "acceptance_committee_meeting", "name": "接收预备党员党委会会议记录", "category": "C", "fill_method": "blue"},
    {"stage": "probationary-acceptance", "node": "committee-approve", "slug": "acceptance_report_form", "name": "发展党员上报表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-acceptance", "node": "oath", "slug": "oath_record", "name": "入党宣誓活动记实表", "category": "B", "fill_method": "black"},

    # 阶段五：预备党员的培养考察与转正
    {"stage": "probationary-regularization", "node": "probationary-training", "slug": "probationary_inspection_form", "name": "预备党员考察教育情况登记表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "probationary-training", "slug": "thought_report_regularization", "name": "思想汇报（转正）", "category": "A", "fill_method": "red"},
    {"stage": "probationary-regularization", "node": "probationary-training", "slug": "party_class_certificate_probationary", "name": "党课结业证及党课心得（预备党员）", "category": "A", "fill_method": "red"},
    {"stage": "probationary-regularization", "node": "regularization-apply", "slug": "regularization_application", "name": "转正申请书", "category": "A", "fill_method": "red"},
    {"stage": "probationary-regularization", "node": "symposium-2", "slug": "regularization_opinion_meeting", "name": "预备党员转正党内外群众意见会议记录", "category": "C", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "regularization-defense", "slug": "regularization_evaluation", "name": "预备党员转正测评表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "publicity-2", "slug": "regularization_publicity", "name": "预备党员转正公示情况表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "committee-approve-2", "slug": "regularization_pre_review", "name": "发展（转正）党员材料预审表", "category": "B", "fill_method": "blue"},
    {"stage": "probationary-regularization", "node": "branch-vote-2", "slug": "regularization_vote_summary", "name": "预备党员转正表决票汇总表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "committee-approve-2", "slug": "regularization_committee_meeting", "name": "转正党员党委会会议记录", "category": "C", "fill_method": "blue"},
    {"stage": "probationary-regularization", "node": "committee-approve-2", "slug": "volunteer_form_committee", "name": "入党志愿书（党委审批）", "category": "A", "fill_method": "blue"},
    {"stage": "probationary-regularization", "node": "branch-vote-2", "slug": "regularization_branch_meeting", "name": "转正党员支部大会会议记录", "category": "C", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "committee-approve-2", "slug": "regularization_report_form", "name": "转正党员上报表", "category": "B", "fill_method": "black"},
    {"stage": "probationary-regularization", "node": "regularization-defense", "slug": "regularization_talk_record", "name": "预备党员转正谈话记实表", "category": "B", "fill_method": "blue"},
]
