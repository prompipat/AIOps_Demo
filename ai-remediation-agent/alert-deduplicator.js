const ANALYSIS_COOLDOWN_MS = Number(process.env.ANALYSIS_COOLDOWN_MS || 5 * 60 * 1000);
const ANALYSIS_ALERT_ALLOWLIST = new Set(
  (process.env.ANALYSIS_ALERT_ALLOWLIST || 'PaymentServiceDown')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const ALERT_PRIORITY = {
    PaymentServiceDown: 100,
    HighPaymentErrorRate: 80,
    LowOrderSuccessRate: 50,
    HighAPILatency: 40
};

const lastAnalysisByService = new Map();
let activeRootIncident = null;

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

function getAlertPriority(alert) {
    return ALERT_PRIORITY[getAlertName(alert)] || 0;
}

function isAnalysisAllowed(alert) {
  return ANALYSIS_ALERT_ALLOWLIST.has(getAlertName(alert));
}

function isSymptomOfSelectedAlert(alert, selectedAlert) {
    const alertName = getAlertName(alert);
    const selectedName = getAlertName(selectedAlert);

    if (selectedName === 'PaymentServiceDown') {
        return [
            'LowOrderSuccessRate',
            'HighPaymentErrorRate',
            'HighAPILatency'
        ].includes(alertName);
    }

    if (selectedName === 'HighPaymentErrorRate') {
        return [
        'LowOrderSuccessRate'
        ].includes(alertName);
    }

    return false;
}

function selectRootAlerts(alerts) {
  const firingAlerts = alerts.filter((alert) => alert.status === 'firing');

  const sorted = firingAlerts
    .slice()
    .sort((a, b) => getAlertPriority(b) - getAlertPriority(a));

  const selected = [];
  const suppressed = [];

  for (const alert of sorted) {
    if (!isAnalysisAllowed(alert)) {
      suppressed.push({
        alert,
        reason: `Suppressed ${getAlertName(alert)} because it is not in ANALYSIS_ALERT_ALLOWLIST`
      });
      continue;
    }

    if (activeRootIncident && nowWithinActiveIncident(activeRootIncident)) {
      const isSameRoot = getAlertName(alert) === activeRootIncident.alertName &&
        getAlertService(alert) === activeRootIncident.service;

      if (!isSameRoot) {
        suppressed.push({
          alert,
          reason: `Suppressed ${getAlertName(alert)} because active root incident ${activeRootIncident.alertName} for ${activeRootIncident.service} is still in cooldown`
        });
        continue;
      }
    }

    const isSymptom = selected.some((selectedAlert) => isSymptomOfSelectedAlert(alert, selectedAlert));

    if (isSymptom) {
      suppressed.push({
        alert,
        reason: `Suppressed symptom alert ${getAlertName(alert)} because stronger root alert is already selected`
      });
      continue;
    }

    selected.push(alert);
  }

  return {
    selected,
    suppressed
  };
}

function nowWithinActiveIncident(incident, now = Date.now()) {
  return incident && now < incident.until;
}

function applyAnalysisCooldown(alerts, now = Date.now()) {
  const selected = [];
  const suppressed = [];

  for (const alert of alerts) {
    const service = getAlertService(alert);
    const lastAnalyzedAt = lastAnalysisByService.get(service) || 0;
    const ageMs = now - lastAnalyzedAt;

    if (ageMs < ANALYSIS_COOLDOWN_MS) {
      suppressed.push({
        alert,
        reason: `Suppressed ${getAlertName(alert)} for ${service}; analysis cooldown has ${Math.ceil((ANALYSIS_COOLDOWN_MS - ageMs) / 1000)}s remaining`
      });
      continue;
    }

    lastAnalysisByService.set(service, now);
    activeRootIncident = {
      alertName: getAlertName(alert),
      service,
      until: now + ANALYSIS_COOLDOWN_MS
    };
    selected.push(alert);
  }

  return {
    selected,
    suppressed
  };
}

function selectAlertsForAnalysis(alerts, now = Date.now()) {
  const rootSelection = selectRootAlerts(alerts);
  const cooldownSelection = applyAnalysisCooldown(rootSelection.selected, now);

  return {
    selected: cooldownSelection.selected,
    suppressed: [
      ...rootSelection.suppressed,
      ...cooldownSelection.suppressed
    ]
  };
}

module.exports = {
  selectAlertsForAnalysis,
  selectRootAlerts,
  applyAnalysisCooldown,
  getAlertName,
  getAlertService,
  isAnalysisAllowed
};
