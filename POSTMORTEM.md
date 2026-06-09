# AIOps Lab — Incident Postmortem

## Scenario 1: High Payment Error Rate

### Timeline
- 11:16 — เพิ่ม FAILURE_RATE = 0.90 (trigger)
- 11:17 — Prometheus ตรวจพบ error rate > 25%
- 11:18 — Alertmanager ส่ง Slack 🔴 CRITICAL
- 11:21 — ตรวจพบ root cause จาก Jaeger trace
- 11:27 — แก้ไข FAILURE_RATE = 0.15
- 11:30 — Slack รับ ✅ RESOLVED

### Root Cause
FAILURE_RATE ถูกตั้งเป็น 0.90 ทำให้ 90% ของ payment ล้มเหลว

### Detection Method
Prometheus alert rule: HighPaymentErrorRate (threshold 25%, for 1m)

### Time to Detect
2-3 นาที (trigger → Slack alert)

### Time to Resolve  
12 นาที (alert → resolved)

### Tools ที่ใช้หา root cause
- Grafana: เห็น error rate spike บน dashboard
- Jaeger: trace แสดง error span ใน payment-service
- Loki: log แสดง "insufficient_funds" ทุก request

---

## Scenario 2: Order Service Latency Spike

### Timeline
- 13:08 — เพิ่ม delay 900–1500ms ใน order-service (trigger)
- 13:09 — Prometheus ตรวจพบ p99 > 800ms
- 13:10 — Alertmanager ส่ง Slack 🟡 WARNING
- 13:13 — หา root cause จาก Jaeger slow trace
- 13:14 — แก้ไข delay กลับเป็น 50–150ms
- 13:16 — Slack รับ ✅ RESOLVED

### Root Cause
Processing delay ใน order-service สูงกว่าปกติ 10x

### Key Learning
Distributed tracing ระบุได้ทันทีว่า bottleneck อยู่ที่ order-service
ไม่ใช่ api-gateway หรือ payment-service

---

## Scenario 3: Payment Service Down

### Timeline
- 13:21 — docker compose stop payment-service (trigger)
- 13:24 — PaymentServiceDown alert firing
- 13:25 — ตรวจพบ container หยุดทำงาน
- 13:27 — docker compose start payment-service
- 13:28 — ✅ RESOLVED

### Root Cause
Container หยุดทำงาน ทำให้ order-service ไม่สามารถ call payment-service ได้

---

## Summary — สิ่งที่เรียนรู้จาก 3 Scenarios

| Scenario | Detection Time | Root Cause Tool | Resolve Method |
|---|---|---|---|
| High Error Rate | ~2 min | Jaeger trace + Loki log | แก้ FAILURE_RATE |
| Latency Spike | ~3 min | Jaeger slow trace | แก้ processing delay |
| Service Down | ~1 min | docker compose ps | docker compose start |

## Action Items
- [ ] เพิ่ม health check endpoint ที่ Prometheus scrape ได้
- [ ] เพิ่ม alert rule: OrderServiceHighLatency แยกออกมา
- [ ] ตั้ง SLO: payment success rate > 95%, p99 latency < 500ms