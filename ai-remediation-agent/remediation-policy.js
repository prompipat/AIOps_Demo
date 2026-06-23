const ALLOWED_SERVICES = new Set([
    'api-gateway',
    'order-service',
    'payment-service',
]);

const ACTION_POLICY = {
    check_logs: {
        risk: 'low',
        requiresApproval: false
    },
    view_metrics: {
        risk: 'low',
        requiresApproval: false
    },
    restart_service: {
        risk: 'high',
        requiresApproval: true
    }
};

function canRestartForAlert(alertname) {
    return String(alertname || '').endsWith('TargetDown')
        || alertname === 'ManualRestartApprovalTest';
}

function evaluatePolicy(actionRequest) {
    const actionName = actionRequest.action;
    const service = actionRequest.service;

    const policy = ACTION_POLICY[actionName];

    if (!policy) {
        return {
            allowed: false,
            reason: `Unsupported action: ${actionName}`
        };
    }

    if (service && !ALLOWED_SERVICES.has(service)) {
        return {
            allowed: false,
            reason: `Unsupported service: ${service}`
        };
    }

    if (actionName === 'restart_service' && !canRestartForAlert(actionRequest.alertname)) {
        return {
            allowed: false,
            reason: `Restart is only allowed for target-down alerts; received ${actionRequest.alertname || 'unknown alert'}`
        };
    }

    return {
        allowed: true,
        action: actionName,
        service,
        risk: policy.risk,
        requiresApproval: policy.requiresApproval
    };
}

module.exports = {
    evaluatePolicy,
    canRestartForAlert,
    ALLOWED_SERVICES,
    ACTION_POLICY
}
