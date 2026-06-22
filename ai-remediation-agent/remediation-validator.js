const { inspectServiceState } = require('./mcp-docker-client');

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
const ALERTMANAGER_URL = process.env.ALERTMANAGER_URL || 'http://alertmanager:9093';
const VALIDATION_INTERVAL_MS = Number(process.env.REMEDIATION_VALIDATION_INTERVAL_MS || 30 * 1000);
const VALIDATION_ATTEMPTS = Number(process.env.REMEDIATION_VALIDATION_ATTEMPTS || 2);
const VALIDATION_TIMEOUT_MS = Number(process.env.REMEDIATION_VALIDATION_TIMEOUT_MS || 3000);

function matchesAlert(labels, action) {
    return labels?.alertname === action.alertname
        && (!action.service || labels?.service === action.service);
}

async function queryPrometheusAlert(action) {
    const axios = require('axios');
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/alerts`, {
        timeout: VALIDATION_TIMEOUT_MS
    });
    const alerts = response.data?.data?.alerts || [];

    return alerts.some((alert) => alert.state === 'firing' && matchesAlert(alert.labels, action));
}

async function queryAlertmanagerAlert(action) {
    const axios = require('axios');
    const response = await axios.get(`${ALERTMANAGER_URL}/api/v2/alerts`, {
        params: { active: true, silenced: true, inhibited: true, unprocessed: true },
        timeout: VALIDATION_TIMEOUT_MS
    });
    const alerts = Array.isArray(response.data) ? response.data : [];

    return alerts.some((alert) => matchesAlert(alert.labels, action));
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyObservations(observations) {
    const dockerHealthy = observations.map((item) => item.docker.healthy);
    const prometheusFiring = observations.map((item) => item.prometheusFiring);
    const allHealthy = dockerHealthy.every(Boolean);
    const allUnhealthy = dockerHealthy.every((value) => !value);
    const allFiring = prometheusFiring.every(Boolean);
    const allInactive = prometheusFiring.every((value) => !value);
    const alertmanagerFiring = observations.at(-1).alertmanagerFiring;

    if (allHealthy && allInactive) {
        return {
            outcome: alertmanagerFiring ? 'cancelled_already_recovered' : 'cancelled_resolved',
            shouldExecute: false,
            reason: alertmanagerFiring
                ? 'Service is healthy and the Prometheus condition is inactive; Alertmanager propagation is pending.'
                : 'Service is healthy and the alert is resolved.'
        };
    }

    if (allHealthy && allFiring) {
        return {
            outcome: 'alert_state_mismatch',
            shouldExecute: false,
            reason: 'Service is healthy but the Prometheus alert condition remains active.'
        };
    }

    if (allUnhealthy && allFiring) {
        return {
            outcome: 'validated',
            shouldExecute: true,
            reason: 'Service remains unhealthy and the Prometheus alert condition remains active.'
        };
    }

    return {
        outcome: 'alert_state_mismatch',
        shouldExecute: false,
        reason: 'Service and alert observations changed or disagreed between validation attempts.'
    };
}

async function validateRestartAction(action, dependencies = {}) {
    const inspectService = dependencies.inspectService || inspectServiceState;
    const queryPrometheus = dependencies.queryPrometheus || queryPrometheusAlert;
    const queryAlertmanager = dependencies.queryAlertmanager || queryAlertmanagerAlert;
    const sleep = dependencies.sleep || wait;
    const attempts = dependencies.attempts || VALIDATION_ATTEMPTS;
    const intervalMs = dependencies.intervalMs ?? VALIDATION_INTERVAL_MS;
    const observations = [];

    try {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const [docker, prometheusFiring, alertmanagerFiring] = await Promise.all([
                inspectService(action.service),
                queryPrometheus(action),
                queryAlertmanager(action)
            ]);

            observations.push({
                attempt: attempt + 1,
                timestamp: new Date().toISOString(),
                docker,
                prometheusFiring,
                alertmanagerFiring
            });

            if (attempt < attempts - 1) {
                await sleep(intervalMs);
            }
        }

        return {
            ...classifyObservations(observations),
            observations
        };
    } catch (error) {
        return {
            outcome: 'validation_failed',
            shouldExecute: false,
            reason: error.message,
            observations
        };
    }
}

module.exports = {
    validateRestartAction,
    classifyObservations,
    matchesAlert
};
