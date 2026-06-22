const crypto = require('crypto');

const actions = new Map();
const auditEvents = [];
const ACTION_APPROVAL_TTL_MS = Number(process.env.ACTION_APPROVAL_TTL_MS || 10 * 60 * 1000);

function now() {
    return new Date().toISOString();
}

function createActionRequest(input) {
    const id = crypto.randomUUID();
    const createdAt = now();

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
        incidentId: input.incidentId || null,
        createdAt,
        updatedAt: createdAt,
        expiresAt: input.requiresApproval
            ? new Date(Date.parse(createdAt) + ACTION_APPROVAL_TTL_MS).toISOString()
            : null,
        validation: null,
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
    addAudit(id, 'updated', {
        ...patch,
        previousStatus: current.status,
        newStatus: updated.status
    });

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

function resetStore() {
    actions.clear();
    auditEvents.length = 0;
}

module.exports = {
    createActionRequest,
    updateAction,
    getAction,
    listActions,
    addAudit,
    listAuditEvents,
    resetStore
};
