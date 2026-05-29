const http = require('http')

const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(200)
        res.end('webhook-logger ready')
        return
    }

    let body = '';

    req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const path = req.url;
      console.log('\n' + '='.repeat(60));
      console.log(`[${new Date().toISOString()}] ALERT on ${path}`);
      payload.alerts.forEach(alert => {
        const status = alert.status.toUpperCase();
        const name = alert.labels.alertname;
        const severity = alert.labels.severity;
        const summary = alert.annotations.summary;
        const desc = alert.annotations.description;
        console.log(`  ${status} | ${severity.toUpperCase()} | ${name}`);
        console.log(`  Summary: ${summary}`);
        console.log(`  Detail:  ${desc}`);
      });
      console.log('='.repeat(60));
    } catch (e) {
      console.log('raw:', body);
    }
    res.writeHead(200);
    res.end('ok');
  });
});

server.listen(5001, () => console.log('webhook-logger listening on :5001'));