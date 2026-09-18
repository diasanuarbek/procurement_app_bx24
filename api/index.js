const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const url = req.url || '';
    const file = url.includes('install') ? 'install.html' : 'index.html';
    const filePath = path.join(process.cwd(), file);

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return res.status(200).send(content);
    } catch (e) {
        return res.status(500).send('Error loading page: ' + e.message);
    }
};
