const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePolicy } = require('../remediation-policy');

test('allows restart for target-down alerts', () => {
    const result = evaluatePolicy({
        action: 'restart_service',
        service: 'order-service',
        alertname: 'OrderServiceTargetDown'
    });

    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, true);
});

test('blocks restart for no-traffic alerts', () => {
    const result = evaluatePolicy({
        action: 'restart_service',
        service: 'payment-service',
        alertname: 'PaymentServiceDown'
    });

    assert.equal(result.allowed, false);
    assert.match(result.reason, /target-down alerts/);
});
