-- New office plans use a parameter-bound, short-lived JIT grant. Existing pending
-- plans are version 0 so a rollout does not invalidate work already previewed.
ALTER TABLE office_plans ADD COLUMN jit_version INTEGER NOT NULL DEFAULT 0 CHECK(jit_version IN (0,1));

-- Keep the PDP/PEP outcome alongside the existing request audit trail.
ALTER TABLE operation_logs ADD COLUMN policy_decision TEXT CHECK(policy_decision IN ('allow','deny'));
ALTER TABLE operation_logs ADD COLUMN policy_reason TEXT;
