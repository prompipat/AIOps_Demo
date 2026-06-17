const { evaluatePolicy } = require('./remediation-policy');
const {
    createActionRequest,
    updateAction,
    getAction
} = require('./approval-store');
const { callDockerTool } = require('./mcp-docker-client');

function normalizeAction(action, alertContext) {
    const rawActionName = String(action.action || '').trim().toLowerCase();
    const aliases = {
        inspect_logs: 'check_logs',
        check_recent_logs: 'check_logs',
        review_logs: 'check_logs',
        query_logs: 'check_logs',
        investigate_logs: 'check_logs',
        investigate_payment_failures: 'check_logs',
        inspect_metrics: 'view_metrics',
        check_metrics: 'view_metrics',
        query_metrics: 'view_metrics',
        view_prometheus_metrics: 'view_metrics',
        inspect_prometheus_metrics: 'view_metrics',
        restart_container: 'restart_service',
        restart_docker_service: 'restart_service',
        restart_payment_service: 'restart_service',
        restart_order_service: 'restart_service',
        restart_api_gateway: 'restart_service'
    };

    let normalizedActionName = aliases[rawActionName] || rawActionName;

    if (!aliases[rawActionName]) {
        if (rawActionName.includes('restart')) {
            normalizedActionName = 'restart_service';
        } else if (rawActionName.includes('log')) {
            normalizedActionName = 'check_logs';
        } else if (rawActionName.includes('metric') || rawActionName.includes('prometheus')) {
            normalizedActionName = 'view_metrics';
        }
    }

    return {
        ...action,
        action: normalizedActionName,
        originalAction: rawActionName,
        service: action.service || alertContext.service
    };
}

function toolForAction(action) {
    if (action === 'check_logs') {
        return 'docker_compose.logs';
    }

    if (action === 'restart_service') {
        return 'docker_compose.restart';
    }

    throw new Error(`No tool mapping for action: ${action}`);
}

async function handleRecommendedAction(action, alertContext) {
    const normalizedAction = normalizeAction(action, alertContext);
    const policy = evaluatePolicy(normalizedAction);

    if (!policy.allowed) {
        return createActionRequest({
            ...normalizedAction,
            alertname: alertContext.name,
            status: 'blocked',
            risk: 'unknown',
            requiresApproval: false,
            reason: policy.reason
        });
    }

    const request = createActionRequest({
        action: normalizedAction.action,
        service: normalizedAction.service,
        originalAction: normalizedAction.originalAction,
        risk: policy.risk,
        requiresApproval: policy.requiresApproval,
        description: normalizedAction.description,
        reason: normalizedAction.reason,
        alertname: alertContext.name,
        status: policy.requiresApproval ? 'pending_approval' : 'auto_executing'
    });

    if (policy.requiresApproval) {
        return request;
    }

    return executeActionRequest(request.id, 'system');
}

async function executeActionRequest(id, actor) {
    const request = getAction(id);
    
    if (!request) {
        throw new Error(`Action not found: ${id}`);
    }

    if (!['pending_approval', 'auto_executing', 'approved'].includes(request.status)) {
        throw new Error(`Action ${id} cannot execute from status ${request.status}`);
    }

    updateAction(id, {
        status: 'executing',
        approvedBy: actor
    });

    try {
        let result;

        if (request.action === 'view_metrics') {
            result = 'Metrics are already collected by the existing Prometheus evidence flow.'
        }
        else {
            result = await callDockerTool(toolForAction(request.action), {
                service: request.service,
                tail: 20
            });
        }

        return updateAction(id, {
            status: 'succeeded',
            result
        });
    } catch (error) {
        return updateAction(id, {
            status: 'failed',
            error: error.message
        });
    }
}

async function approveAction(id, actor) {
    const request = getAction(id);

    if (!request) {
        throw new Error(`Action not found: ${id}`);
    }

    if (request.status !== 'pending_approval') {
        throw new Error(`Action ${id} is not pending approval`);
    }

    updateAction(id, {
        status: 'approved',
        approvedBy: actor
    });

    return executeActionRequest(id, actor);
}

function rejectAction(id, actor) {
    const request = getAction(id);

    if (!request) {
        throw new Error(`Action not found: ${id}`);
    }

    if (request.status !== 'pending_approval') {
        throw new Error(`Action ${id} is not pending approval`);
    }

    return updateAction(id, {
        status: 'rejected',
        rejectedBy: actor
    });
}

module.exports = {
    handleRecommendedAction,
    approveAction,
    rejectAction,
    executeActionRequest
}
