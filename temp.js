const express = require('express');
const app = express();

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
});

console.log('Open this URL in your browser:\n', authUrl);

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const { tokens } = await oAuth2Client.getToken(code);
  console.log('Refresh token:', tokens.refresh_token);
  res.send('✅ Token received! You can close this tab.');
  process.exit(0);
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
