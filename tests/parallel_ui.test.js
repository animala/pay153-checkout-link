const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for UI state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('starts three account jobs concurrently and switches logs by account', async t => {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:5000/pay153/?embedded=1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const {window} = dom;
  window.matchMedia = () => ({matches:false, addEventListener() {}, removeEventListener() {}});
  window.open = () => null;
  window.TextDecoder = global.TextDecoder;
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const accounts = [1, 2, 3].map(id => ({
    id,
    email: `account-${id}@example.com`,
    types: ['plus_trial'],
    type_labels: ['Plus 试用'],
  }));
  const checkoutBodies = [];
  let activeStarts = 0;
  let maxActiveStarts = 0;

  window.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('/api/pay153/accounts?')) {
      return response({ok:true, items:accounts, selected_id:1, selected_types:['plus_trial']});
    }
    const tokenMatch = target.match(/\/api\/pay153\/accounts\/(\d+)\/token/);
    if (tokenMatch) {
      const id = Number(tokenMatch[1]);
      return response({ok:true, id, email:`account-${id}@example.com`, access_token:`token-${id}`, types:['plus_trial'], type_labels:['Plus 试用']});
    }
    if (target === 'api/checkout') {
      const body = JSON.parse(options.body);
      checkoutBodies.push(body);
      activeStarts += 1;
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
      await new Promise(resolve => setTimeout(resolve, 30));
      activeStarts -= 1;
      return response({ok:true, job_id:`job-${body.token.at(-1)}`, queue_position:0}, 202);
    }
    if (target.startsWith('api/checkout-progress?')) {
      const id = new URL(target, window.location.href).searchParams.get('job_id').at(-1);
      return response({
        id:`job-${id}`, status:'running', percent:Number(id) * 20,
        text:`账号 ${id} 正在工作`, logs:[{time:`10:00:0${id}`, message:`log-${id}`}],
        queue_position:0,
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  window.eval(script);
  await waitFor(() => window.document.querySelectorAll('#accountSelect option').length === 3);
  await waitFor(() => window.document.querySelector('#tokenHint').textContent.includes('3 个账号'));

  assert.equal(window.document.querySelector('#parallelCount').value, '3');
  assert.equal(window.document.querySelector('#openInRoxy'), null);
  assert.ok(window.document.querySelector('#openPaypalProtocol'));
  assert.ok(window.document.querySelector('#historyList'));
  assert.ok(window.document.querySelector('#clearHistory'));
  window.document.querySelector('#clearHistory').click();
  await waitFor(() => window.document.querySelector('#historyList').textContent.includes('暂无历史提链记录'));
  window.document.querySelector('#checkoutForm').dispatchEvent(new window.Event('submit', {bubbles:true, cancelable:true}));

  await waitFor(() => checkoutBodies.length === 3);
  await waitFor(() => window.document.querySelectorAll('.task-progress-item').length === 3);
  await waitFor(() => window.document.querySelector('#logBox').textContent.includes('log-1'));
  assert.equal(maxActiveStarts, 3);
  assert.deepEqual(checkoutBodies.map(item => item.token).sort(), ['token-1', 'token-2', 'token-3']);
  assert.equal(window.document.querySelector('#activeLogAccount').textContent, 'account-1@example.com');
  assert.match(window.document.querySelector('#logBox').textContent, /log-1/);

  window.document.querySelector('[data-task-key="account-3"]').click();
  assert.equal(window.document.querySelector('#activeLogAccount').textContent, 'account-3@example.com');
  assert.match(window.document.querySelector('#logBox').textContent, /log-3/);
});
