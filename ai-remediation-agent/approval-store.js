const crypto = require('crypto');

const actions = new Map();
const auditEvents = [];

function now() {
    return new Date().toISOString();
}

function createActionRequest(input) {
    const id = crypto.randomUUID();

    const request = {
        id,
        status: input.status || 'proposed',
        action: input.action,
        service: input.service,
        risk: input.risk,
        requiresApproval: input.requiresApproval,
        reason: input.reason || '',
        description: input.description || '',
        alertname: input.alertname || '',
        createdAt: now(),
        updatedAt: now(),
        result: null,
        error: null,
    };

    actions.set(id, request);
    addAudit(id, 'created', { status: request.status });

    return request;
}

function updateAction(id, patch) {
    const current = actions.get(id);

    if (!current) {
        return null;
    }

    const updated = {
        ...current,
        ...patch,
        updatedAt: now()
    };

    actions.set(id, updated);
    addAudit(id, 'updated', patch);

    return updated;
}

function getAction(id) {
    return actions.get(id) || null;
}

function listActions() {
    return Array.from(actions.values())
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function addAudit(actionId, event, data = {}) {
    auditEvents.push({
        id: crypto.randomUUID(),
        actionId,
        event,
        data,
        timestamp: now()
    });
}

function listAuditEvents() {
    return [...auditEvents];
}

module.exports = {
    createActionRequest,
    updateAction,
    getAction,
    listActions,
    addAudit,
    listAuditEvents
};
