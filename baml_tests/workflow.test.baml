function fixture(
    phase: WorkflowPhase,
    approved: bool = false,
    repairs: int = 0,
) -> WorkflowSnapshot {
    WorkflowSnapshot {
        phase: phase,
        cancelled: false,
        approval_valid: approved,
        repair_attempts: repairs,
        policy_version: policy_version(),
        capability_ready: true,
        context: "fixture",
    }
}

test "plan requires human approval" {
    let decision = next_step(fixture("plan"), WorkflowOutcome { status: "passed", summary: "plan" });
    assert.equal(decision.kind, "await-approval")
}

test "approved plan enters implementation" {
    let decision = next_step(fixture("plan", approved = true), WorkflowOutcome { status: "passed", summary: "plan" });
    assert.equal(decision.phase, "implementation");
    assert.equal(decision.kind, "invoke")
}

test "repair limit survives resume" {
    let failed = WorkflowOutcome { status: "failed", summary: "check failed" };
    assert.is_true(next_step(fixture("verification", approved = true, repairs = 2), failed).repair);
    assert.equal(
        next_step(fixture("verification", approved = true, repairs = 3), failed).kind,
        "blocked",
    )
}

test "changed approval prevents implementation" {
    assert.equal(
        next_step(fixture("implementation"), WorkflowOutcome { status: "none", summary: "" }).kind,
        "await-approval",
    )
}

test "provider errors do not consume repair budget" {
    let decision = next_step(
        fixture("implementation", approved = true),
        WorkflowOutcome { status: "error", summary: "login required" },
    );
    assert.equal(decision.kind, "blocked");
    assert.equal(decision.repair, false)
}

test "handoff requests host verified completion" {
    assert.equal(
        next_step(
            fixture("handoff", approved = true),
            WorkflowOutcome { status: "passed", summary: "ready" },
        ).kind,
        "complete",
    )
}
