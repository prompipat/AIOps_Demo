const crypto = require('crypto');

const INCIDENT_PROCESS_INTERVAL_MS = Number(process.env.INCIDENT_PROCESS_INTERVAL_MS || 90 * 1000);
const INCIDENT_DEDUPE_TTL_MS = Number(process.env.INCIDENT_DEDUPE_TTL_MS || 10 * 60 * 1000);
const INCIDENT_QUEUE_MAX_SIZE = Number(process.env.INCIDENT_QUEUE_MAX_SIZE || 50);

const ALERT_PRIORITY = {
  ApiGatewayTargetDown: 110,
  OrderServiceTargetDown: 110,
  PaymentServiceTargetDown: 110,
  PaymentServiceDown: 100,
  HighPaymentErrorRate: 80,
  LowOrderSuccessRate: 50,
  HighAPILatency: 40
};

const SEVERITY_PRIORITY = {
  critical: 1000,
  warning: 500,
  info: 100,
  unknown: 0
};

const queue = [];
const incidentsByKey = new Map();
let processor = null;
let processing = false;
let timer = null;
let lastStartedAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function getAlertName(alert) {
  return alert.labels?.alertname || 'unknown';
}

function getAlertService(alert) {
  const labels = alert.labels || {};

  if (labels.service) {
    return labels.service;
  }

  const alertname = labels.alertname || '';
  const team = labels.team || '';

  if (alertname.includes('Payment') || team === 'payments') {
    return 'payment-service';
  }

  if (alertname.includes('Order') || team === 'orders') {
    return 'order-service';
  }

  if (alertname.includes('API') || team === 'platform') {
    return 'api-gateway';
  }

  return 'unknown';
}

function getAlertSeverity(alert) {
  return alert.labels?.severity || 'unknown';
}

function getIncidentKey(alert) {
  return `${getAlertName(alert)}:${getAlertService(alert)}`;
}

function getIncidentPriority(alert) {
  const severity = getAlertSeverity(alert);
  return (SEVERITY_PRIORITY[severity] || 0) + (ALERT_PRIORITY[getAlertName(alert)] || 0);
}

function sortQueue() {
  queue.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }

    return a.createdAt.localeCompare(b.createdAt);
  });
}

function enqueueAlerts(alerts) {
  const enqueued = [];
  const skipped = [];
  const now = Date.now();

  for (const alert of alerts || []) {
    if (alert.status !== 'firing') {
      skipped.push({
        alertname: getAlertName(alert),
        service: getAlertService(alert),
        reason: `Ignored ${alert.status || 'unknown'} alert`
      });
      continue;
    }

    const key = getIncidentKey(alert);
    const existing = incidentsByKey.get(key);

    if (existing && ['queued', 'processing'].includes(existing.status)) {
      existing.alert = alert;
      existing.receivedCount += 1;
      existing.updatedAt = nowIso();
      skipped.push({
        alertname: getAlertName(alert),
        service: getAlertService(alert),
        reason: `Merged duplicate firing alert into existing ${existing.status} incident ${existing.id}`
      });
      continue;
    }

    if (existing && now - existing.completedAtMs < INCIDENT_DEDUPE_TTL_MS) {
      skipped.push({
        alertname: getAlertName(alert),
        service: getAlertService(alert),
        reason: `Ignored recently processed incident ${existing.id}; dedupe TTL still active`
      });
      continue;
    }

    if (queue.length >= INCIDENT_QUEUE_MAX_SIZE) {
      skipped.push({
        alertname: getAlertName(alert),
        service: getAlertService(alert),
        reason: `Incident queue is full at ${INCIDENT_QUEUE_MAX_SIZE} items`
      });
      continue;
    }

    const incident = {
      id: crypto.randomUUID(),
      key,
      alert,
      alertname: getAlertName(alert),
      service: getAlertService(alert),
      severity: getAlertSeverity(alert),
      priority: getIncidentPriority(alert),
      status: 'queued',
      receivedCount: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      completedAt: null,
      completedAtMs: 0,
      error: null
    };

    incidentsByKey.set(key, incident);
    queue.push(incident);
    enqueued.push(incident);
  }

  sortQueue();
  kickWorker();

  return {
    enqueued,
    skipped,
    queue: listIncidents()
  };
}

function listIncidents() {
  return Array.from(incidentsByKey.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function updateIncident(id, patch) {
  const incident = Array.from(incidentsByKey.values()).find((item) => item.id === id);

  if (!incident) {
    return null;
  }

  Object.assign(incident, patch, { updatedAt: nowIso() });
  return incident;
}

function startIncidentWorker(handler) {
  processor = handler;
  kickWorker();
}

function kickWorker() {
  if (!processor || processing || timer || queue.length === 0) {
    return;
  }

  const elapsedMs = lastStartedAt ? Date.now() - lastStartedAt : INCIDENT_PROCESS_INTERVAL_MS;
  const waitMs = Math.max(0, INCIDENT_PROCESS_INTERVAL_MS - elapsedMs);

  timer = setTimeout(processNextIncident, waitMs);
}

async function processNextIncident() {
  timer = null;

  if (!processor || processing || queue.length === 0) {
    kickWorker();
    return;
  }

  processing = true;
  const incident = queue.shift();
  incident.status = 'processing';
  incident.startedAt = nowIso();
  incident.updatedAt = incident.startedAt;
  lastStartedAt = Date.now();

  try {
    await processor(incident);
    incident.status = 'completed';
  } catch (error) {
    incident.status = 'failed';
    incident.error = error.message;
  } finally {
    incident.completedAt = nowIso();
    incident.completedAtMs = Date.now();
    incident.updatedAt = incident.completedAt;
    processing = false;
    kickWorker();
  }
}

module.exports = {
  enqueueAlerts,
  startIncidentWorker,
  listIncidents,
  updateIncident,
  getAlertName,
  getAlertService
};
