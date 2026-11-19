const defaults = {
  similarityThreshold: 0.32,
  classifierModel: "deepseek-flash",
  identityReply: "我是中国民航大学理学院独立开发的党员发展辅助系统",
  identityExit: "你也可以问我党员发展流程和材料。",
  chitchatExit: "你也可以问我党员发展流程和材料。",
  businessExit: "如需确认，请向辅导员或学校官方渠道核对。",
  outOfScopeReply: "我主要协助查询党员发展流程、材料与填写要求。如果你想问这方面的问题，可以告诉我具体阶段；其他问题请使用相应的官方渠道。",
  clarificationReply: "你是想了解党员发展流程、材料填写，还是培养阶段的问题？能补充一下具体场景吗？",
  uncertainExitReply: "我暂时不能确定你要查询的具体事项。你可以换个更明确的问法，或向辅导员咨询。",
  serviceFailureReply: "回答服务暂时不可用。你可以稍后重试，或向辅导员核对相关要求。"
};

export function mentorConfig(env = {}) {
  const supplied = env.RAG_MIN_SIMILARITY !== undefined && String(env.RAG_MIN_SIMILARITY).trim() !== "";
  const value = Number(env.RAG_MIN_SIMILARITY);
  return {
    ...defaults,
    similarityThreshold: supplied && Number.isFinite(value) && value >= 0 && value <= 1 ? value : defaults.similarityThreshold,
    classifierModel: typeof env.INTENT_MODEL === "string" && env.INTENT_MODEL.trim() ? env.INTENT_MODEL.trim() : defaults.classifierModel
  };
}
