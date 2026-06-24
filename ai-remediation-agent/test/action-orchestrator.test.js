const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createActionRequest,
    getAction,
    listAuditEvents,
    resetStore,
    updateAction
} = require('../approval-store');
const {
    handleRecommendedAction,
    approveAction,
    normalizeServiceName,
    setValidationDependencies
} = require('../action-orchestrator');

function pendingRestart() {
    return createActionRequest({
        status: 'pending_approval',
        action: 'restart_service',
        service: 'payment-service',
        alertname: 'PaymentServiceTargetDown',
        risk: 'high',
        requiresApproval: true,
        incidentId: 'incident-test'
    });
}

test.beforeEach(() => {
    resetStore();
    setValidationDependencies({});
});

test('creates pending restart approval for target-down alerts', async () => {
    const result = await handleRecommendedAction({
        action: 'restart_service',
        service: 'payment-service:3002',
        reason: 'payment target is down'
    }, {
        name: 'PaymentServiceTargetDown',
        service: 'payment-service',
        incidentId: 'incident-target-down'
    });

    assert.equal(result.status, 'pending_approval');
    assert.equal(result.risk, 'high');
    assert.equal(result.alertname, 'PaymentServiceTargetDown');
    assert.equal(result.service, 'payment-service');
});

test('normalizes service host and URL aliases', () => {
    assert.equal(normalizeServiceName('api-gateway:3000'), 'api-gateway');
    assert.equal(normalizeServiceName('http://order-service:3001/metrics'), 'order-service');
    assert.equal(normalizeServiceName('https://payment-service:3002/health'), 'payment-service');
});

test('creates pending restart approval for other target-down services with host ports', async () => {
    const orderResult = await handleRecommendedAction({
        action: 'restart_service',
        service: 'order-service:3001',
        reason: 'order target is down'
    }, {
        name: 'OrderServiceTargetDown',
        service: 'order-service',
        incidentId: 'incident-order-target-down'
    });

    const apiResult = await handleRecommendedAction({
        action: 'restart_service',
        service: 'api-gateway:3000',
        reason: 'api target is down'
    }, {
        name: 'ApiGatewayTargetDown',
        service: 'api-gateway',
        incidentId: 'incident-api-target-down'
    });

    assert.equal(orderResult.status, 'pending_approval');
    assert.equal(orderResult.service, 'order-service');
    assert.equal(apiResult.status, 'pending_approval');
    assert.equal(apiResult.service, 'api-gateway');
});

test('blocks restart approval for no-traffic alerts', async () => {
    const result = await handleRecommendedAction({
        action: 'restart_service',
        service: 'payment-service',
        reason: 'payment traffic is missing'
    }, {
        name: 'PaymentServiceDown',
        service: 'payment-service',
        incidentId: 'incident-no-traffic'
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.risk, 'unknown');
    assert.match(result.reason, /target-down alerts/);
});

test('expires stale approval without running validation', async () => {
    const request = pendingRestart();
    updateAction(request.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    let inspected = false;
    setValidationDependencies({
        inspectService: async () => {
            inspected = true;
        }
    });

    const result = await approveAction(request.id, 'tester');

    assert.equal(result.status, 'expired');
    assert.equal(inspected, false);
});

test('blocks a duplicate approval while the first approval is validating', async () => {
    const request = pendingRestart();
    let releaseInspection;
    const inspection = new Promise((resolve) => {
        releaseInspection = resolve;
    });
    setValidationDependencies({
        attempts: 1,
        intervalMs: 0,
        inspectService: async () => inspection,
        queryPrometheus: async () => false,
        queryAlertmanager: async () => false
    });

    const firstApproval = approveAction(request.id, 'first-user');
    await assert.rejects(
        approveAction(request.id, 'second-user'),
        /is not pending approval/
    );
    releaseInspection({
        exists: true,
        running: true,
        healthy: true,
        health: 'healthy',
        basis: 'docker_healthcheck'
    });
    const result = await firstApproval;

    assert.equal(result.status, 'cancelled_resolved');
});

test('records validation outcome in the action audit trail', async () => {
    const request = pendingRestart();
    setValidationDependencies({
        attempts: 2,
        intervalMs: 0,
        sleep: async () => {},
        inspectService: async () => ({
            exists: true,
            running: true,
            healthy: true,
            health: 'healthy',
            basis: 'docker_healthcheck'
        }),
        queryPrometheus: async () => true,
        queryAlertmanager: async () => true
    });

    const result = await approveAction(request.id, 'tester');
    const events = listAuditEvents().filter((event) => event.actionId === request.id);

    assert.equal(result.status, 'alert_state_mismatch');
    assert.equal(getAction(request.id).validation.outcome, 'alert_state_mismatch');
    assert.ok(events.some((event) => event.data.status === 'validating'));
    assert.ok(events.some((event) => event.data.status === 'alert_state_mismatch'));
});
