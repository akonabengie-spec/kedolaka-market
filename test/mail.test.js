'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const nodemailer = require('nodemailer');

test('configured SMTP delivery remains compatible with the upgraded Nodemailer transport', async function () {
  let receivedMessage = '';
  const smtpServer = net.createServer(function (socket) {
    socket.setEncoding('utf8');
    socket.write('220 KEDOLAKA test SMTP\r\n');
    let input = '';
    let receivingMessage = false;
    socket.on('data', function (chunk) {
      input += chunk;
      let newline = input.indexOf('\n');
      while (newline !== -1) {
        const line = input.slice(0, newline).replace(/\r$/, '');
        input = input.slice(newline + 1);
        if (receivingMessage) {
          if (line === '.') {
            receivingMessage = false;
            socket.write('250 2.0.0 Message accepted by local test server\r\n');
          } else {
            receivedMessage += line + '\n';
          }
        } else if (/^(EHLO|HELO)\s/i.test(line)) {
          socket.write('250 KEDOLAKA test SMTP\r\n');
        } else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line) || /^RSET$/i.test(line)) {
          socket.write('250 2.1.0 OK\r\n');
        } else if (/^DATA$/i.test(line)) {
          receivingMessage = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT$/i.test(line)) {
          socket.write('221 2.0.0 Closing connection\r\n');
          socket.end();
        } else {
          socket.write('500 5.5.1 Unsupported test SMTP command\r\n');
        }
        newline = input.indexOf('\n');
      }
    });
  });

  await new Promise(function (resolve, reject) {
    smtpServer.once('error', reject);
    smtpServer.listen(0, '127.0.0.1', resolve);
  });
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: smtpServer.address().port,
    secure: false,
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 3000
  });

  try {
    const result = await transport.sendMail({
      from: 'KEDOLAKA test <reset@example.test>',
      to: 'customer@example.test',
      subject: 'Password reset verification',
      text: 'This email was accepted only by a local test SMTP server.'
    });
    assert.deepEqual(result.accepted, ['customer@example.test']);
    assert.deepEqual(result.rejected, []);
    assert.match(receivedMessage, /Subject: Password reset verification/i);
    assert.match(receivedMessage, /accepted only by a local test SMTP server/i);
  } finally {
    transport.close();
    await new Promise(function (resolve, reject) {
      smtpServer.close(function (error) { if (error) reject(error); else resolve(); });
    });
  }
});
