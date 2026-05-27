const http = require('http');

const ITEMS = ['laptop', 'phone', 'headphones', 'keyboard', 'monitor'];
const USERS = ['user-001', 'user-002','user-003','user-004','user-005'];

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sendOrder() {
    const body = JSON.stringify({
        item: randomItem(ITEMS),
        quantity: Math.ceil(Math.random() * 3),
        userId: randomItem(USERS),
    });

    const req = http.request({
        hostname: 'api-gateway',
        port: 3000,
        path: '/order',
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)},
    }, res => {
        res.resume();
        console.log(`[${new Date().toISOString()}] POST /order -> ${res.statusCode}`);
    });

    req.on('error', err => console.error('load-gen error:', err.message));
    req.write(body);
    req.end();
}

// ยิง request ทุก 2 วินาที
console.log('Load generator started — sending requests every 2s');
setInterval(sendOrder, 2000);

// warm up หลัง 5 วินาที
setTimeout(() => {
  console.log('Sending burst of 10 requests...');
  for (let i = 0; i < 10; i++) setTimeout(sendOrder, i * 200);
}, 5000);
