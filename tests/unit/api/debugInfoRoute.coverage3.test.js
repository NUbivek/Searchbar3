import handler from '../../../src/pages/api/debug-info';

describe('/api/debug-info', () => {
  function createRes() {
    return {
      statusCode: 200,
      jsonPayload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.jsonPayload = payload;
        return this;
      }
    };
  }

  it('returns status, env, headers, method, and timestamp', () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const req = {
      method: 'POST',
      headers: {
        'x-test-header': 'debug-info'
      }
    };
    const res = createRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.status).toBe('ok');
    expect(res.jsonPayload.env).toBe('test');
    expect(res.jsonPayload.method).toBe('POST');
    expect(res.jsonPayload.headers).toEqual(req.headers);
    expect(typeof res.jsonPayload.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(res.jsonPayload.timestamp))).toBe(false);

    process.env.NODE_ENV = previousEnv;
  });
});
