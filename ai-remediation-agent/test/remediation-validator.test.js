const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRestartAction } = require('../remediation-validator');

const action = {
    alertname: 'PaymentServiceDown',
    service: 'payment-service'
};

function dependencies({ docker, prometheus, alertmanager }) {
    let dockerIndex = 0;
    let prometheusIndex = 0;
    let alertmanagerIndex = 0;

    return {
        attempts: 2,
        intervalMs: 0,
        sleep: async () => {},
        inspectService: async () => docker[dockerIndex++],
        queryPrometheus: async () => prometheus[prometheusIndex++],
        queryAlertmanager: async () => alertmanager[alertmanagerIndex++]
    };
}

const healthy = {
    exists: true,
    running: true,
    healthy: true,
    health: 'healthy',
    basis: 'docker_healthcheck'
};

const unhealthy = {
    exists: true,
    running: false,
    healthy: false,
    health: 'stopped',
    basis: 'container_running_state'
};

test('cancels a restart when the service recovered before Alertmanager updates', async () => {
    const result = await validateRestartAction(action, dependencies({
        docker: [healthy, healthy],
        prometheus: [false, false],
        alertmanager: [true, true]
    }));

    assert.equal(result.outcome, 'cancelled_already_recovered');
    assert.equal(result.shouldExecute, false);
    assert.equal(result.observations.length, 2);
});

test('recognizes a fully resolved alert', async () => {
    const result = await validateRestartAction(action, dependencies({
        docker: [healthy, healthy],
        prometheus: [false, false],
        alertmanager: [false, false]
    }));

    assert.equal(result.outcome, 'cancelled_resolved');
    assert.equal(result.shouldExecute, false);
});

test('reports a mismatch when a healthy service still violates the alert condition', async () => {
    const result = await validateRestartAction(action, dependencies({
        docker: [healthy, healthy],
        prometheus: [true, true],
        alertmanager: [true, true]
    }));

    assert.equal(result.outcome, 'alert_state_mismatch');
    assert.equal(result.shouldExecute, false);
});

test('permits restart only after two unhealthy and firing observations', async () => {
    const result = await validateRestartAction(action, dependencies({
        docker: [unhealthy, unhealthy],
        prometheus: [true, true],
        alertmanager: [true, true]
    }));

    assert.equal(result.outcome, 'validated');
    assert.equal(result.shouldExecute, true);
});

test('fails closed when a required query fails', async () => {
    const result = await validateRestartAction(action, {
        attempts: 2,
        intervalMs: 0,
        inspectService: async () => healthy,
        queryPrometheus: async () => {
            throw new Error('Prometheus unavailable');
        },
        queryAlertmanager: async () => true
    });

    assert.equal(result.outcome, 'validation_failed');
    assert.equal(result.shouldExecute, false);
    assert.match(result.reason, /Prometheus unavailable/);
});
