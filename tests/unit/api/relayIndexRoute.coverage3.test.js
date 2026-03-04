import handler from '../../../src/pages/api/relay/index';
import { createMockReq } from './testUtils';

describe('/api/relay', () => {
  function createHtmlRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(name, value) {
        this.headers[name] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  it('returns the relay landing page html', async () => {
    const req = createMockReq();
    const res = createHtmlRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html');
    expect(res.body).toContain('OAuth Relay System');
    expect(res.body).toContain('research.bivek.ai');
  });
});
