const crypto = require('crypto');
const https = require('https');

function postTweet(text) {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !accessToken) {
    console.error('[Tweeter] Missing X API credentials');
    return Promise.reject(new Error('Missing credentials'));
  }

  const method = 'POST';
  const url = 'https://api.x.com/2/tweets';
  const body = JSON.stringify({ text });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: '1.0'
  };

  const paramStr = Object.keys(params).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  const baseStr = method + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(paramStr);
  const signingKey = encodeURIComponent(apiSecret) + '&' + encodeURIComponent(accessSecret);
  const signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');

  params.oauth_signature = signature;
  const authHeader = 'OAuth ' + Object.keys(params).sort().map(k => encodeURIComponent(k) + '="' + encodeURIComponent(params[k]) + '"').join(', ');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com',
      path: '/2/tweets',
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 201) {
            console.log('[Tweeter] Posted:', json.data?.id);
            resolve(json);
          } else {
            console.error('[Tweeter] Error:', res.statusCode, data);
            reject(new Error(data));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { postTweet };
