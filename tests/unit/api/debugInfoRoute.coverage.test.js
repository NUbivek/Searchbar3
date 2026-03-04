import handler from '../../../src/pages/api/debug-info';

describe('/api/debug-info', () => {
  function createRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  it('returns normalized debug info', () => {
    const req = {
      method: 'GET',
      headers: {
        'x-test-header': 'debug-info'
      }
    };
    const res = createRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.env).toBe(process.env.NODE_ENV);
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.headers).toEqual(req.headers);
    expect(res.body.method).toBe('GET');
  });
});
