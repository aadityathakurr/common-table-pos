import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

test('network printer adapter sends the exact ESC/POS bytes over TCP', async () => {
  const receivedPayload = new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks)));
      socket.on('error', reject);
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        process.env.NODE_ENV = 'test';
        process.env.POS_PRINTER_MODE = 'network';
        process.env.POS_PRINTER_HOST = '127.0.0.1';
        process.env.POS_PRINTER_PORT = String(port);
        const printer = await import('../dist/printer.js?network-adapter-test');
        const payload = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x41, 0x03]);
        assert.deepEqual(printer.printerStatus(), { mode: 'network', host: '127.0.0.1', port });
        await printer.sendToPrinter(payload);
        assert.deepEqual(await receivedPayload, payload);
        server.close();
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
  await receivedPayload;
});

test('production defaults to disabled and cannot start a mock listener', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.POS_PRINTER_MODE;
  delete process.env.POS_PRINTER_HOST;
  delete process.env.POS_PRINTER_PORT;
  const printer = await import('../dist/printer.js?production-disabled-test');
  assert.deepEqual(printer.printerStatus(), { mode: 'disabled' });
  assert.equal(printer.startPrinterAdapter(), undefined);
  await assert.rejects(printer.sendToPrinter(Buffer.from('test')), /disabled/);
});

test('production rejects the mock printer mode', async () => {
  process.env.NODE_ENV = 'production';
  process.env.POS_PRINTER_MODE = 'mock';
  await assert.rejects(import('../dist/printer.js?production-mock-rejected-test'), /not allowed in production/);
});
