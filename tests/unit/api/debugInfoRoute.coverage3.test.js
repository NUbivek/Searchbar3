import handler from '../../../src/pages/api/debug-info';

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

describe('/api/debug-info', () => {
  it('returns debug payload with request context', () => {
    const req = {
      method: 'POST',
      headers: {
        'x-test-header': 'present'
      }
    };
    const res = createRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.method).toBe('POST');
    expect(res.body.headers).toEqual(req.headers);
    expect(typeof res.body.timestamp).toBe('string');
  });
});
